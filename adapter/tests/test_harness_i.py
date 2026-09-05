"""
Phase I — Reviewer Pass -> ControlState feedback (ADR-003 finding F-3, authority-map A-4).

Covers: ReviewerVerdict / _derive_pending_verdict() (reviewer.py),
resolve_control_state()'s pending_reviewer_verdict input (control_state.py),
and INV-18 (a pending ReviewerVerdict of severity >= MEDIUM forces the next
resolve's execution_mode into {CAUTIOUS, RECOVERY} — never NORMAL — and never
touches permission on its own; one-shot, cleared by run_one_iteration()).

Run: pytest adapter/tests/test_harness_i.py -v
"""

from __future__ import annotations

import sys
import uuid
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.control_state import resolve_control_state
from harness.diagnostics import BeliefHealth, CoverageHealth, Diagnostics, ExecutionHealth, VerificationHealth
from harness.evidence import EvidenceStore
from harness.failure_modes import FailureDiagnostics
from harness.hypothesis import HypothesisSet
from harness.loop import run_one_iteration
from harness.memory import MemoryState
from harness.recovery import StrategyState
from harness.reviewer import ReviewerVerdict, ReviewFinding, _derive_pending_verdict
from harness.state_store import HarnessRunState
from harness.task_graph import Task, TaskGraph
from harness.world_model import Belief, Contradiction, Observation, WorldModel


def _healthy_diagnostics() -> Diagnostics:
    return Diagnostics(
        belief_health=BeliefHealth(freshness=0.9, consistency=0.9, support=0.9),
        coverage_health=CoverageHealth(symptom_coverage=0.8, explanation_coverage=0.8),
        verification_health=VerificationHealth(strength=0.8, feasibility=0.8),
        execution_health=ExecutionHealth(progress_rate=0.7, failure_recurrence=0.1, oscillation_score=0.1),
    )


# ─── _derive_pending_verdict ──────────────────────────────────────────────────


def test_derive_pending_verdict_none_when_no_findings():
    assert _derive_pending_verdict([]) is None


def test_derive_pending_verdict_none_when_only_low_severity():
    findings = [ReviewFinding(lens="implementer", finding_type="gap", description="minor", severity="LOW")]
    assert _derive_pending_verdict(findings) is None


def test_derive_pending_verdict_picks_highest_severity():
    findings = [
        ReviewFinding(lens="implementer", finding_type="gap", description="low prio", severity="LOW"),
        ReviewFinding(lens="reviewer", finding_type="gap", description="med prio", severity="MEDIUM"),
        ReviewFinding(lens="adversarial", finding_type="contradiction", description="high prio", severity="HIGH"),
    ]
    verdict = _derive_pending_verdict(findings)
    assert verdict is not None
    assert verdict.severity == "HIGH"
    assert verdict.lens == "adversarial"
    assert verdict.summary == "high prio"


def test_reviewer_verdict_roundtrip():
    v = ReviewerVerdict(severity="MEDIUM", lens="reviewer", summary="a gap")
    assert ReviewerVerdict.from_dict(v.to_dict()) == v


# ─── INV-18 — resolve_control_state's pending_reviewer_verdict input ──────────


def test_inv18_medium_severity_forces_cautious():
    cs = resolve_control_state(
        _healthy_diagnostics(),
        WorldModel(),
        FailureDiagnostics(),
        pending_reviewer_verdict=ReviewerVerdict(severity="MEDIUM", lens="reviewer", summary="gap"),
    )
    assert cs.execution_mode == "CAUTIOUS"
    assert cs.permission == "ALLOW"
    assert any("Pending reviewer verdict" in n and "reviewer" in n for n in cs.notes)


def test_inv18_high_severity_forces_cautious():
    cs = resolve_control_state(
        _healthy_diagnostics(),
        WorldModel(),
        FailureDiagnostics(),
        pending_reviewer_verdict=ReviewerVerdict(severity="HIGH", lens="adversarial", summary="bad"),
    )
    assert cs.execution_mode == "CAUTIOUS"
    assert cs.permission == "ALLOW"


def test_inv18_low_severity_does_not_force_cautious():
    cs = resolve_control_state(
        _healthy_diagnostics(),
        WorldModel(),
        FailureDiagnostics(),
        pending_reviewer_verdict=ReviewerVerdict(severity="LOW", lens="implementer", summary="trivial"),
    )
    assert cs.execution_mode == "NORMAL"


def test_inv18_never_sets_deny():
    """A pending verdict never sets permission=DENY, even at HIGH severity, on an
    otherwise-clean world model — the resolver's own tiers still own blocking."""
    cs = resolve_control_state(
        _healthy_diagnostics(),
        WorldModel(),
        FailureDiagnostics(),
        pending_reviewer_verdict=ReviewerVerdict(severity="HIGH", lens="adversarial", summary="bad"),
    )
    assert cs.permission == "ALLOW"


def test_inv18_does_not_override_tier1_system_breaking():
    """When Tier 1 already fires (SYSTEM_BREAKING contradiction -> DENY/RECOVERY), a
    pending verdict does not downgrade or upgrade that outcome — it only adds a note."""
    wm = WorldModel()
    wm.contradictions.append(
        Contradiction(
            id="c1",
            description="x",
            severity="SYSTEM_BREAKING",
            involved_belief_ids=[],
            type="pairwise",
            scope="local",
        )
    )
    cs = resolve_control_state(
        _healthy_diagnostics(),
        wm,
        FailureDiagnostics(),
        pending_reviewer_verdict=ReviewerVerdict(severity="HIGH", lens="adversarial", summary="bad"),
    )
    assert cs.permission == "DENY"
    assert cs.execution_mode == "RECOVERY"
    assert any("Pending reviewer verdict" in n for n in cs.notes)


def test_inv18_execution_mode_never_normal_with_medium_plus_verdict():
    for severity in ("MEDIUM", "HIGH"):
        cs = resolve_control_state(
            _healthy_diagnostics(),
            WorldModel(),
            FailureDiagnostics(),
            pending_reviewer_verdict=ReviewerVerdict(severity=severity, lens="reviewer", summary="x"),
        )
        assert cs.execution_mode in ("CAUTIOUS", "RECOVERY")
        assert cs.execution_mode != "NORMAL"


def test_inv18_no_verdict_is_a_no_op():
    cs = resolve_control_state(
        _healthy_diagnostics(), WorldModel(), FailureDiagnostics(), pending_reviewer_verdict=None
    )
    assert cs.execution_mode == "NORMAL"
    assert cs.notes == []


# ─── One-shot consumption via run_one_iteration / HarnessRunState ─────────────


def _make_state() -> HarnessRunState:
    wm = WorldModel()
    wm.add_observation(Observation(id="obs-0", content="observation 0", source="test"))
    wm.add_belief(Belief(id="b-0", statement="belief 0", confidence=0.8, derived_from=["obs-0"]))
    return HarnessRunState(
        run_id=str(uuid.uuid4()),
        world_model=wm,
        diagnostics=_healthy_diagnostics(),
        task_graph=TaskGraph(
            tasks=[
                Task(id="t1", description="primary task", status="ACTIVE", completed_evidence=[], abstraction_level=0)
            ]
        ),
        hypothesis_set=HypothesisSet(active=[], eliminated=[]),
        evidence_store=EvidenceStore(),
        strategy_state=StrategyState(),
        memory_state=MemoryState(),
        failure_diagnostics=FailureDiagnostics(),
    )


def test_inv18_one_shot_consumed_then_cleared_by_run_one_iteration():
    state = _make_state()
    state.pending_reviewer_verdict = ReviewerVerdict(severity="HIGH", lens="reviewer", summary="carried over")

    result = run_one_iteration(
        world_model=state.world_model,
        diagnostics=state.diagnostics,
        hypothesis_set=state.hypothesis_set,
        task_graph=state.task_graph,
        failure_diagnostics=state.failure_diagnostics,
        memory_state=state.memory_state,
        strategy_state=state.strategy_state,
        step_count=0,
        harness_run_state=state,
        run_id=state.run_id,
    )

    assert result.get("escalated") is not True
    control_state_a = result["control_state_a"]
    assert control_state_a.execution_mode == "CAUTIOUS"
    assert any("Pending reviewer verdict" in n for n in control_state_a.notes)
    # one-shot: consumed and cleared by this same call
    assert state.pending_reviewer_verdict is None

    # The resolve after that (this same iteration's Sub-step B) already reverted —
    # confirms the verdict was not applied a second time within the same iteration.
    control_state_b = result["control_state_b"]
    assert not any("Pending reviewer verdict" in n for n in control_state_b.notes)


def test_inv18_next_iteration_without_new_verdict_reverts_to_tiers_alone():
    state = _make_state()
    state.pending_reviewer_verdict = ReviewerVerdict(severity="HIGH", lens="reviewer", summary="carried over")

    run_one_iteration(
        world_model=state.world_model,
        diagnostics=state.diagnostics,
        hypothesis_set=state.hypothesis_set,
        task_graph=state.task_graph,
        failure_diagnostics=state.failure_diagnostics,
        memory_state=state.memory_state,
        strategy_state=state.strategy_state,
        step_count=0,
        harness_run_state=state,
        run_id=state.run_id,
    )
    assert state.pending_reviewer_verdict is None

    # Second iteration: nothing pending anymore (reviewer_pass didn't run — no
    # belief_dep_graph/output_contract supplied — so nothing new was produced either).
    result2 = run_one_iteration(
        world_model=state.world_model,
        diagnostics=state.diagnostics,
        hypothesis_set=state.hypothesis_set,
        task_graph=state.task_graph,
        failure_diagnostics=state.failure_diagnostics,
        memory_state=state.memory_state,
        strategy_state=state.strategy_state,
        step_count=1,
        harness_run_state=state,
        run_id=state.run_id,
    )
    assert result2.get("escalated") is not True
    # One-shot: the verdict consumed by iteration 1 must not still be influencing
    # iteration 2 — whatever iteration 2's execution_mode is (other, unrelated
    # per-iteration signals such as a matched failure pattern can independently
    # elevate it to CAUTIOUS), it must not carry the "Pending reviewer verdict" note
    # a second time, since nothing new was produced (no belief_dep_graph/
    # output_contract, so reviewer_pass never ran this iteration either).
    assert not any("Pending reviewer verdict" in n for n in result2["control_state_a"].notes)


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
