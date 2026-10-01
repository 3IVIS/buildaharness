"""
Regression tests for the lexical-pattern consolidation done as Phase 0 of
the internal plan — proves the fixes actually changed consumer behavior
(not just that the shared getters return the expected content, already covered in
test_script_utils.py).

Run: pytest adapter/tests/test_lexical_consolidation_drift.py -v
"""

from __future__ import annotations

import sys
import uuid
from pathlib import Path
from typing import cast

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.caller_state import CallerState
from harness.contradiction import detect_abstraction_contradictions
from harness.evidence import Evidence, EvidenceType, ReliabilityClass
from harness.output_contract import OutputContract, validate_output_contract
from harness.task_graph import estimate_world_model_granularity
from harness.world_model import Belief, WorldModel


@pytest.fixture(autouse=True)
def _lexical_checks_on(monkeypatch):
    """These tests exercise the harness's lexical checks, which are off by default (harness/lexical_off.py)."""
    monkeypatch.setenv("HARNESS_LEXICAL_MODE", "enabled")


def _belief(statement: str, confidence: float = 0.8, bid: str | None = None) -> Belief:
    return Belief(id=bid or str(uuid.uuid4()), statement=statement, confidence=confidence, derived_from=["init"])


def _evidence(obs: str, reliability: str = "HIGH") -> Evidence:
    return Evidence(
        id=str(uuid.uuid4()),
        obs=obs,
        source="test",
        reliability=cast(ReliabilityClass, reliability),
        evidence_type=cast(EvidenceType, "OBSERVATION"),
        freshness="2026-01-01T00:00:00+00:00",
    )


def test_check_caller_specific_constraints_still_works_after_migration():
    """output_contract.py's caller-constraint check reads lexical_patterns.get_constraint_negation_words()
    instead of its own hardcoded copy — regression guard that the end-to-end constraint-violation check still works."""
    caller_state = CallerState(current_constraints=["must not mention pricing details"])
    violations = validate_output_contract(
        "Our pricing details are $10/month.", OutputContract(), caller_state
    ).violations
    assert len(violations) == 1
    assert "must not mention pricing details" in violations[0]


def test_detect_abstraction_contradictions_now_recognizes_statement_and_expression():
    """Regression: contradiction.py's own line_level_keywords list used to be narrower than
    task_graph.py's statement_markers (missing "statement"/"expression"/"lineno"/"line:") — a
    belief stated at this granularity against a module-level task silently went unflagged."""
    belief = _belief("the return statement has an off-by-one expression error")
    task_graph = {"abstraction_level": "module"}
    results = detect_abstraction_contradictions([belief], task_graph)
    assert len(results) == 1
    assert results[0].severity == "LOW"
    assert results[0].type == "abstraction"


def test_estimate_world_model_granularity_now_recognizes_column_and_char():
    """Regression: task_graph.py's own statement_markers list used to be narrower than
    contradiction.py's line_level_keywords (missing "column "/"char "/" ln "/":line") — beliefs
    using this phrasing were silently classified as module-level (0) instead of statement-level (2)."""
    wm = WorldModel()
    wm.beliefs.append(_belief("the parser fails at column 5, char 12 of the input"))
    wm.beliefs.append(_belief("the tokenizer breaks at column 8 of the same line"))
    assert estimate_world_model_granularity(wm) == 2


# Chinese-language fixtures — first-pass phrasing, not verified by a fluent Chinese speaker; see
# the internal plan's Fixture-writing caveat.
def test_detect_abstraction_contradictions_recognizes_chinese_statement_level_markers():
    """The shared granularity-markers.json now has a zh statementLevelMarkers entry
    ("语句"/"表达式") mirroring the English "statement"/"expression" entries exercised above."""
    belief = _belief("返回语句存在一个表达式错误")
    task_graph = {"abstraction_level": "module"}
    results = detect_abstraction_contradictions([belief], task_graph)
    assert len(results) == 1
    assert results[0].severity == "LOW"
    assert results[0].type == "abstraction"


def test_estimate_world_model_granularity_recognizes_chinese_line_and_char_markers():
    """zh statementLevelMarkers ("行号"/"字符"/"列") mirroring the English "column "/"char "
    entries exercised above."""
    wm = WorldModel()
    wm.beliefs.append(_belief("解析器在行号5、字符12处失败"))
    wm.beliefs.append(_belief("分词器在同一行的第8列处出错"))
    assert estimate_world_model_granularity(wm) == 2
