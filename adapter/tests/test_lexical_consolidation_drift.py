"""
Regression tests for the lexical-pattern consolidation done as Phase 0 of
plans/lexical_functions_hardening_plan.html — proves the fixes actually changed consumer behavior
(not just that the shared getters return the expected content, already covered in
test_script_utils.py), and drift-guards that reviewer.py/hypothesis.py now share one negation-word
set instead of two independently-hardcoded, drifted copies.

Run: pytest adapter/tests/test_lexical_consolidation_drift.py -v
"""

from __future__ import annotations

import sys
import uuid
from pathlib import Path
from typing import cast

sys.path.insert(0, str(Path(__file__).parent.parent))

from harness import hypothesis as hypothesis_module
from harness import reviewer as reviewer_module
from harness.caller_state import CallerState
from harness.contradiction import detect_abstraction_contradictions
from harness.evidence import Evidence, EvidenceStore, EvidenceType, ReliabilityClass
from harness.hypothesis import Hypothesis, check_contradicting_evidence
from harness.output_contract import check_caller_specific_constraints
from harness.reviewer import reviewer_lens
from harness.task_graph import estimate_world_model_granularity
from harness.world_model import Belief, WorldModel


def _belief(statement: str, confidence: float = 0.8, bid: str | None = None) -> Belief:
    return Belief(id=bid or str(uuid.uuid4()), statement=statement, confidence=confidence, derived_from=["init"])


def _evidence(obs: str, reliability: str = "HIGH") -> Evidence:
    return Evidence(
        id=str(uuid.uuid4()),
        obs=obs,
        source="test",
        reliability=cast(ReliabilityClass, reliability),
        evidence_type=cast(EvidenceType, "OBSERVATION"),
        freshness=1.0,
    )


def test_reviewer_and_hypothesis_share_one_evidence_negation_word_set():
    """Drift-guard: both modules now read the same lexical_patterns.get_evidence_negation_words()
    at import time, rather than each hardcoding its own (previously-drifted) copy."""
    assert reviewer_module._EVIDENCE_NEGATION_WORDS == hypothesis_module._EVIDENCE_NEGATION_WORDS
    assert "unavailable" in reviewer_module._EVIDENCE_NEGATION_WORDS


def test_reviewer_lens_now_detects_unavailable_as_negation():
    """Regression: reviewer.py's own negation_keywords set used to be missing "unavailable"
    (present in hypothesis.py's identical-purpose set) — a HIGH-reliability "service unavailable"
    observation contradicting a "service is available" belief was silently never flagged."""
    wm = WorldModel()
    belief = _belief("the payment service is available")
    wm.beliefs.append(belief)

    es = EvidenceStore()
    es.entries.append(_evidence("the payment service is currently unavailable"))

    findings = reviewer_lens(world_model=wm, output_contract=None, task_graph=None, evidence_store=es)
    gap_findings = [f for f in findings if f.finding_type == "gap"]
    assert len(gap_findings) == 1, (
        f"expected reviewer_lens to flag the unavailable/available contradiction, got: {findings}"
    )


def test_check_contradicting_evidence_still_detects_unavailable():
    """hypothesis.py's own set already had "unavailable" before this consolidation — regression
    guard that migrating it to the shared source didn't narrow it."""
    hyp = Hypothesis(
        id="h1",
        explanation="the payment service is available",
        confidence=0.6,
        predicted_observations=["the payment service is available"],
        discriminating_evidence=[],
        generation_sources=["symptom_inference"],
    )
    es = EvidenceStore()
    es.entries.append(_evidence("the payment service is currently unavailable"))
    assert check_contradicting_evidence(hyp, es) is True


def test_check_caller_specific_constraints_still_works_after_migration():
    """output_contract.py's check_caller_specific_constraints now reads
    lexical_patterns.get_constraint_negation_words() instead of its own hardcoded copy — regression
    guard that the end-to-end constraint-violation check still works unchanged."""
    caller_state = CallerState(current_constraints=["must not mention pricing details"])
    violations = check_caller_specific_constraints("Our pricing details are $10/month.", caller_state)
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
