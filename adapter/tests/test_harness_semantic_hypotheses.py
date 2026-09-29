"""Semantic hypotheses in the Python harness — twin of packages/harness/src/harness-runtime-semantic-hypotheses.test.ts
and packages/aielia/src/semantic-hypotheses.test.ts — plus the HARNESS_LEXICAL_OFF switch for the hypothesis checks."""

from __future__ import annotations

import asyncio
import json
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.evidence import Evidence, EvidenceStore
from harness.hypothesis import (
    Hypothesis,
    HypothesisSet,
    check_contradicting_evidence,
    generate_hypotheses,
    symptom_inference,
)
from harness.lexical_off import harness_lexical_active, resolve_harness_lexical_off
from harness.semantic_hypotheses import (
    SEMANTIC_SOURCE,
    add_semantic_hypotheses,
    eliminate_contradicted,
    has_semantic_hypotheses,
    judge_hypotheses_against_evidence,
    judge_new_observations,
    propose_competing_explanations,
    seed_semantic_hypotheses,
    semantic_hypotheses_enabled,
)
from harness.world_model import Belief, WorldModel


def run(coro):
    return asyncio.run(coro)


def fake_litellm(monkeypatch, content=None, raises=False, seen=None):
    """Replaces litellm.acompletion with one that returns `content` (or raises), recording each call's messages."""

    async def acompletion(model, messages, temperature):
        if seen is not None:
            seen.append(messages)
        if raises:
            raise RuntimeError("boom")
        return types.SimpleNamespace(choices=[types.SimpleNamespace(message=types.SimpleNamespace(content=content))])

    monkeypatch.setitem(sys.modules, "litellm", types.SimpleNamespace(acompletion=acompletion))


TWO = {
    "hypotheses": [
        {
            "explanation": "Soft-deleted rows are exported but hidden on the dashboard",
            "predicted_observations": ["rows with deleted_at set"],
            "separating_check": "count deleted rows",
            "confidence": 0.5,
        },
        {
            "explanation": "The dashboard refreshed before late rows arrived",
            "predicted_observations": ["rows newer than the refresh"],
            "separating_check": "compare refresh time to max(created_at)",
            "confidence": 0.5,
        },
    ]
}


# ── the flag ──────────────────────────────────────────────────────────────────


def test_flag_is_off_unless_a_truthy_value_is_set():
    assert semantic_hypotheses_enabled({}) is False
    assert semantic_hypotheses_enabled({"AUDIT_SEMANTIC_HYPOTHESES": ""}) is False
    for v in ("0", "false", "off", "no", "disabled"):
        assert semantic_hypotheses_enabled({"AUDIT_SEMANTIC_HYPOTHESES": v}) is False, v
    for v in ("1", "true", "on", "yes", "enabled", " ON "):
        assert semantic_hypotheses_enabled({"AUDIT_SEMANTIC_HYPOTHESES": v}) is True, v


# ── proposing ─────────────────────────────────────────────────────────────────


def test_propose_parses_two_explanations_and_sends_the_request(monkeypatch):
    seen: list = []
    fake_litellm(monkeypatch, json.dumps(TWO), seen=seen)
    out = run(propose_competing_explanations("why do the counts differ?", [], []))
    assert out is not None and len(out) == 2
    assert out[0]["separating_check"] == "count deleted rows" and out[0]["confidence"] == 0.5
    assert json.loads(seen[0][1]["content"])["request"] == "why do the counts differ?"


def test_propose_one_explanation_or_none_is_not_a_competition(monkeypatch):
    fake_litellm(monkeypatch, json.dumps({"hypotheses": [TWO["hypotheses"][0]]}))
    assert run(propose_competing_explanations("q", [], [])) is None
    fake_litellm(monkeypatch, '{"hypotheses": []}')
    assert run(propose_competing_explanations("q", [], [])) is None


def test_propose_keeps_at_most_four_and_skips_blanks(monkeypatch):
    many = [{"explanation": f"cause {i}", "predicted_observations": ["a", 3, " "]} for i in range(6)]
    many.append({"explanation": "  ", "predicted_observations": []})
    fake_litellm(monkeypatch, json.dumps({"hypotheses": many}))
    out = run(propose_competing_explanations("q", [], []))
    assert [h["explanation"] for h in out] == ["cause 0", "cause 1", "cause 2", "cause 3"]
    assert out[0]["predicted_observations"] == ["a"]


def test_propose_fails_open(monkeypatch):
    fake_litellm(monkeypatch, raises=True)
    assert run(propose_competing_explanations("q", [], [])) is None
    fake_litellm(monkeypatch, "not json at all")
    assert run(propose_competing_explanations("q", [], [])) is None
    fake_litellm(monkeypatch, '{"hypotheses": "nope"}')
    assert run(propose_competing_explanations("q", [], [])) is None


# ── judging ───────────────────────────────────────────────────────────────────

HYPS = [
    {"id": "sem_0", "explanation": "a", "predicted_observations": ["x"]},
    {"id": "sem_1", "explanation": "b", "predicted_observations": ["y"]},
]


def test_judge_returns_what_is_ruled_out_and_ignores_unknown_ids(monkeypatch):
    fake_litellm(monkeypatch, '{"contradicted": [{"id": "sem_0", "reason": "none deleted"}, {"id": "ghost"}]}')
    assert run(judge_hypotheses_against_evidence(HYPS, ["no rows are soft-deleted"])) == [
        {"id": "sem_0", "reason": "none deleted"}
    ]


def test_judge_makes_no_call_with_nothing_to_judge_and_fails_open(monkeypatch):
    seen: list = []
    fake_litellm(monkeypatch, "{}", seen=seen)
    assert run(judge_hypotheses_against_evidence([], ["o"])) is None
    assert run(judge_hypotheses_against_evidence(HYPS, [])) is None
    assert seen == []
    fake_litellm(monkeypatch, raises=True)
    assert run(judge_hypotheses_against_evidence(HYPS, ["o"])) is None
    fake_litellm(monkeypatch, "garbage")
    assert run(judge_hypotheses_against_evidence(HYPS, ["o"])) is None


# ── state updates ─────────────────────────────────────────────────────────────


def test_add_semantic_hypotheses_tags_them_and_is_idempotent():
    hs = HypothesisSet()
    created = add_semantic_hypotheses(hs, TWO["hypotheses"])
    assert [h.id for h in created] == ["sem_0", "sem_1"]
    assert all(h.generation_sources == [SEMANTIC_SOURCE] for h in hs.active)
    assert hs.active[0].separating_check == "count deleted rows" and hs.active[0].discriminating_evidence == []
    assert has_semantic_hypotheses(hs)
    assert add_semantic_hypotheses(hs, TWO["hypotheses"]) == []  # already there
    assert len(hs.active) == 2


def test_add_semantic_hypotheses_ignores_nothing_and_blanks():
    hs = HypothesisSet()
    assert add_semantic_hypotheses(hs, None) == []
    assert add_semantic_hypotheses(hs, []) == []
    assert add_semantic_hypotheses(hs, [{"explanation": "  ", "predicted_observations": []}]) == []
    assert hs.active == []


def test_eliminate_contradicted_moves_only_named_semantic_hypotheses():
    hs = HypothesisSet()
    add_semantic_hypotheses(hs, TWO["hypotheses"])
    template = Hypothesis("tmpl", "template seed", 0.4, [], [], ["symptom_inference"])
    hs.active.append(template)
    removed = eliminate_contradicted(hs, [{"id": "sem_0", "reason": "none deleted"}, {"id": "tmpl"}, {"id": "ghost"}])
    assert [h.id for h in removed] == ["sem_0"]
    assert [h.id for h in hs.active] == ["sem_1", "tmpl"]  # the template seed is never removed by this path
    assert [(h.id, r.reason) for h, r in hs.eliminated] == [("sem_0", "CONTRADICTING_EVIDENCE")]
    assert eliminate_contradicted(hs, None) == [] and eliminate_contradicted(hs, []) == []


def test_separating_check_round_trips_and_is_absent_when_empty():
    hs = HypothesisSet()
    add_semantic_hypotheses(hs, TWO["hypotheses"])
    restored = HypothesisSet.from_dict(hs.to_dict())
    assert restored.active[0].separating_check == "count deleted rows"
    plain = Hypothesis("h", "e", 0.5, [], [], ["symptom_inference"])
    assert "separating_check" not in plain.to_dict()  # existing payloads are byte-identical


# ── HARNESS_LEXICAL_OFF for the hypothesis checks ─────────────────────────────


def ev(id_: str, obs: str) -> Evidence:
    return Evidence(id=id_, obs=obs, reliability="HIGH", source="log", evidence_type="OBSERVATION", freshness=1.0)


def _world_with_observations():
    wm = WorldModel()
    wm.beliefs.append(Belief(id="b1", statement="the export is complete", confidence=0.8, derived_from=["src"]))
    es = EvidenceStore()
    es.append(ev("e1", "export rows timed out"))
    es.append(ev("e2", "export rows loaded fine"))
    return wm, es


def test_lexical_off_switch_resolution():
    assert resolve_harness_lexical_off({}) == frozenset()
    assert resolve_harness_lexical_off({"HARNESS_LEXICAL_OFF": "all"}) == frozenset(
        {"hypothesis-clustering", "hypothesis-negation-elimination"}
    )
    assert resolve_harness_lexical_off({"HARNESS_LEXICAL_OFF": "hypothesis-clustering, nonsense"}) == frozenset(
        {"hypothesis-clustering"}
    )
    assert harness_lexical_active("hypothesis-clustering", {}) is True
    assert harness_lexical_active("hypothesis-clustering", {"HARNESS_LEXICAL_OFF": "hypothesis-clustering"}) is False
    assert (
        harness_lexical_active("hypothesis-negation-elimination", {"HARNESS_LEXICAL_OFF": "hypothesis-clustering"})
        is True
    )


def test_default_is_unchanged_clustering_still_produces_hypotheses(monkeypatch):
    monkeypatch.delenv("HARNESS_LEXICAL_OFF", raising=False)
    wm, es = _world_with_observations()
    assert len(symptom_inference(wm, es)) > 0
    assert len(generate_hypotheses(wm, es)) > 0


def test_clustering_off_produces_nothing_from_word_overlap(monkeypatch):
    monkeypatch.setenv("HARNESS_LEXICAL_OFF", "hypothesis-clustering")
    wm, es = _world_with_observations()
    assert symptom_inference(wm, es) == []


def test_clustering_off_also_disables_the_jaccard_dedupe(monkeypatch):
    monkeypatch.delenv("HARNESS_LEXICAL_OFF", raising=False)
    wm, es = _world_with_observations()
    stub = {"a": "database connection timed out during export", "b": "database connection timed out during export"}
    merged_on = generate_hypotheses(wm, es, fml_stub=stub)
    monkeypatch.setenv("HARNESS_LEXICAL_OFF", "hypothesis-clustering")
    kept_off = generate_hypotheses(wm, es, fml_stub=stub)
    assert sum(h.explanation == stub["a"] for h in merged_on) == 1  # near-identical explanations merged
    assert sum(h.explanation == stub["a"] for h in kept_off) == 2  # dedupe is lexical, so off keeps both


def test_negation_elimination_off_never_eliminates_on_word_overlap(monkeypatch):
    h = Hypothesis("h", "rows arrive", 0.5, ["rows arrive on time"], [], ["symptom_inference"])
    es = EvidenceStore()
    es.append(ev("e", "rows did not arrive on time"))
    monkeypatch.delenv("HARNESS_LEXICAL_OFF", raising=False)
    assert check_contradicting_evidence(h, es) is True
    monkeypatch.setenv("HARNESS_LEXICAL_OFF", "hypothesis-negation-elimination")
    assert check_contradicting_evidence(h, es) is False


@pytest.mark.parametrize("value", ["", "hypothesis-clustering", "all"])
def test_switch_is_read_at_call_time_not_import_time(monkeypatch, value):
    monkeypatch.setenv("HARNESS_LEXICAL_OFF", value)
    assert harness_lexical_active("hypothesis-clustering") is (value == "")


# ── the async driver's two steps (what planner_api._run_planner calls) ─────────


ON = {"AUDIT_SEMANTIC_HYPOTHESES": "1"}


def test_seed_is_a_no_op_without_the_flag_and_makes_no_llm_call(monkeypatch):
    seen: list = []
    fake_litellm(monkeypatch, json.dumps(TWO), seen=seen)
    hs = HypothesisSet()
    assert run(seed_semantic_hypotheses(hs, "why do the counts differ?", env={})) == []
    assert hs.active == [] and seen == []


def test_seed_with_the_flag_adds_the_explanations_once(monkeypatch):
    seen: list = []
    fake_litellm(monkeypatch, json.dumps(TWO), seen=seen)
    hs = HypothesisSet()
    assert len(run(seed_semantic_hypotheses(hs, "why do the counts differ?", env=ON))) == 2
    assert run(seed_semantic_hypotheses(hs, "why do the counts differ?", env=ON)) == []  # asked once
    assert len(seen) == 1 and len(hs.active) == 2


def test_seed_fails_open(monkeypatch):
    hs = HypothesisSet()
    fake_litellm(monkeypatch, raises=True)
    assert run(seed_semantic_hypotheses(hs, "q", env=ON)) == []
    assert hs.active == []


def test_judge_new_observations_eliminates_what_is_ruled_out_and_advances_the_count(monkeypatch):
    seen: list = []
    hs = HypothesisSet()
    add_semantic_hypotheses(hs, TWO["hypotheses"])
    fake_litellm(monkeypatch, '{"contradicted": [{"id": "sem_0", "reason": "none deleted"}]}', seen=seen)
    count = run(judge_new_observations(hs, ["o1", "o2"], 0, env=ON))
    assert count == 2
    assert [h.id for h in hs.active] == ["sem_1"]
    assert json.loads(seen[0][1]["content"])["observations"] == ["o1", "o2"]
    # only the new observation is judged next time, and only the hypothesis still standing
    fake_litellm(monkeypatch, '{"contradicted": []}', seen=seen)
    assert run(judge_new_observations(hs, ["o1", "o2", "o3"], 2, env=ON)) == 3
    payload = json.loads(seen[1][1]["content"])
    assert payload["observations"] == ["o3"] and [h["id"] for h in payload["hypotheses"]] == ["sem_1"]


def test_judge_new_observations_makes_no_call_without_flag_hypotheses_or_news(monkeypatch):
    seen: list = []
    fake_litellm(monkeypatch, '{"contradicted": [{"id": "sem_0"}]}', seen=seen)
    hs = HypothesisSet()
    assert run(judge_new_observations(hs, ["o"], 0, env=ON)) == 0  # no semantic hypotheses
    add_semantic_hypotheses(hs, TWO["hypotheses"])
    assert run(judge_new_observations(hs, ["o"], 0, env={})) == 0  # flag off
    assert run(judge_new_observations(hs, ["o"], 1, env=ON)) == 1  # nothing new
    assert seen == [] and len(hs.active) == 2


def test_judge_new_observations_fails_open_but_still_counts_what_it_saw(monkeypatch):
    hs = HypothesisSet()
    add_semantic_hypotheses(hs, TWO["hypotheses"])
    fake_litellm(monkeypatch, raises=True)
    assert run(judge_new_observations(hs, ["o1"], 0, env=ON)) == 1
    assert len(hs.active) == 2


def test_the_planner_driver_calls_both_steps():
    planner = Path(__file__).parent.parent / "planner_api.py"
    if not planner.exists():  # planner_api.py is private-only; the public tree has no driver to check
        pytest.skip("planner_api.py is not part of this tree")
    source = planner.read_text()
    assert "await seed_semantic_hypotheses(hs, goal)" in source
    assert "await judge_new_observations(" in source
