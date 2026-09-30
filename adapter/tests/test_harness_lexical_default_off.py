"""The Python harness's lexical checks are all OFF by default (harness/lexical_off.py).

Each test runs the same input twice: once at the default (the lexical check says nothing) and once with
that one check switched on via HARNESS_LEXICAL_ON (it fires) — the second run is the control that shows
the input is one the check would otherwise catch."""

from __future__ import annotations

import pytest

from harness.caller_state import CallerState, update_success_criteria
from harness.contradiction import detect_pairwise_contradictions, detect_set_level_contradictions
from harness.lexical_off import HARNESS_LEXICAL_CHECKS, harness_lexical_active
from harness.output_contract import OutputContract, check_caller_specific_constraints, check_required_sections
from harness.preference_extractor import PreferenceSignal, make_preference_extractor
from harness.review_gate import check_code_quality, check_world_model_consistency
from harness.risk import compute_change_scope
from harness.task_graph import Task
from harness.world_model import Belief, WorldModel


@pytest.fixture(autouse=True)
def _clean_lexical_env(monkeypatch):
    for var in ("HARNESS_LEXICAL_MODE", "HARNESS_LEXICAL_ON", "HARNESS_LEXICAL_OFF"):
        monkeypatch.delenv(var, raising=False)


def _belief(bid: str, statement: str, confidence: float = 0.9) -> Belief:
    return Belief(id=bid, statement=statement, confidence=confidence, derived_from=["obs-1"])


def _both(monkeypatch, check: str, run):
    """(result at the default, result with only `check` switched on)."""
    off = run()
    monkeypatch.setenv("HARNESS_LEXICAL_ON", check)
    on = run()
    monkeypatch.delenv("HARNESS_LEXICAL_ON")
    return off, on


def test_every_check_is_off_by_default():
    for check in HARNESS_LEXICAL_CHECKS:
        assert harness_lexical_active(check, {}) is False


def test_negation_pairs_covers_pairwise_and_set_level(monkeypatch):
    triple = [
        _belief("b1", "the deploy build passed"),
        _belief("b2", "the deploy build failed"),
        _belief("b3", "the deploy build passed again"),
    ]
    off, on = _both(
        monkeypatch,
        "negation-pairs",
        lambda: (detect_pairwise_contradictions(triple), detect_set_level_contradictions(triple)),
    )
    assert off == ([], [])
    assert on[0] and on[1]


def test_review_negation(monkeypatch):
    wm = WorldModel()
    belief = _belief("b1", "caching is enabled")
    belief.reliability = "HIGH"  # the review gate reads this attribute
    wm.beliefs.append(belief)
    off, on = _both(
        monkeypatch,
        "review-negation",
        lambda: check_world_model_consistency({"description": "removes caching is enabled in the module"}, wm).passed,
    )
    assert off is True
    assert on is False


def test_review_phrases(monkeypatch):
    class _Store:
        def check_tool_availability(self, name: str) -> bool:
            return name == "linter"

    off, on = _both(
        monkeypatch,
        "review-phrases",
        lambda: check_code_quality({"description": "this change has a syntax error"}, _Store()).passed,
    )
    assert off is True
    assert on is False


def test_constraint_negation(monkeypatch):
    cs = CallerState(current_constraints=["Do not use tabs"])
    off, on = _both(
        monkeypatch, "constraint-negation", lambda: check_caller_specific_constraints("I will not use tabs.", cs)
    )
    assert off == []
    assert on


def test_required_sections_in_a_text_result(monkeypatch):
    contract = OutputContract(required_sections=["Summary"])
    off, on = _both(monkeypatch, "required-sections", lambda: check_required_sections("no heading here", contract))
    assert off == []
    assert on


def test_criterion_scope_stale_flags(monkeypatch):
    def run():
        wm = WorldModel()
        wm.beliefs.append(_belief("b1", "the sky is blue"))
        update_success_criteria(CallerState(success_criteria=["budget approved"]), wm)
        return dict(wm.stale_flags)

    off, on = _both(monkeypatch, "criterion-scope", run)
    assert off == {}
    assert on == {"b1": True}


def test_preference_patterns(monkeypatch):
    extract = make_preference_extractor([PreferenceSignal(patterns=["faster"], field="response_pace", value="fast")])
    off, on = _both(monkeypatch, "preference-patterns", lambda: extract({"feedback_text": "please go faster"}))
    assert off.get("preference_updates", {}) == {}
    assert on["preference_updates"] == {"response_pace": "fast"}


def test_change_scope_keywords(monkeypatch):
    task = Task(id="t1", description="edit function parse in utils.py at line 40")
    off, on = _both(monkeypatch, "change-scope-keywords", lambda: compute_change_scope(task))
    assert off == 0.0
    assert on > 0.0
