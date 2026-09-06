"""
S6 of plans/harness_trajectory_supervisor_plan.html — the ABORT directive and the
Q3 resolution (option a: the supervisor stays entirely out of
resolve_control_state()).

ABORT is wired in run_one_iteration()'s stall branch: the supervisor judges the run
unrecoverable, so the loop escalates immediately with a cannot_make_progress
SurfaceBlocker carrying the supervisor's rationale in current_task_summary — no
ladder / replan that iteration. Flag-gated (HARNESS_TRAJECTORY_SUPERVISOR).

Run: pytest adapter/tests/test_harness_supervisor_s6.py -q --noconftest
"""

from __future__ import annotations

import inspect
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.control_state import resolve_control_state
from harness.diagnostics import (
    BeliefHealth,
    CoverageHealth,
    Diagnostics,
    ExecutionHealth,
    VerificationHealth,
)
from harness.failure_modes import FailureDiagnostics
from harness.hypothesis import HypothesisSet
from harness.loop import run_one_iteration
from harness.memory import MemoryState
from harness.recovery import RecoveryBudget, StrategyState
from harness.supervisor import SupervisorDirective
from harness.task_graph import Task, TaskGraph
from harness.world_model import Belief, Observation, WorldModel

STALL_HISTORY = [0, 0, 0, 0, 0, 0]  # proxy 1: no completion advance over STALL_WINDOW


def _healthy_diagnostics() -> Diagnostics:
    return Diagnostics(
        belief_health=BeliefHealth(freshness=0.9, consistency=0.9, support=0.9),
        coverage_health=CoverageHealth(symptom_coverage=0.9, explanation_coverage=0.9),
        verification_health=VerificationHealth(strength=0.9, feasibility=0.9),
        execution_health=ExecutionHealth(progress_rate=0.9, failure_recurrence=0.1, oscillation_score=0.1),
    )


class _MockHarnessRunState:
    def __init__(self) -> None:
        self.escalation_pending = False
        self.pending_escalation = None
        self.pending_investigation = None
        self.pending_reviewer_verdict = None
        self.memory_state = MemoryState()
        self.memory_state.journal = []


def _run(
    directive,
    *,
    stalled=True,
    recovery_budget=None,
    harness_run_state=None,
    strategy_state=None,
    monkeypatch=None,
):
    if monkeypatch is not None:
        monkeypatch.setenv("HARNESS_TRAJECTORY_SUPERVISOR", "1")
    wm = WorldModel()
    wm.add_observation(Observation(id="o0", content="obs", source="test"))
    wm.add_belief(Belief(id="b0", statement="belief 0", confidence=0.8, derived_from=["o0"]))
    ss = strategy_state or StrategyState(completion_history=list(STALL_HISTORY) if stalled else [1, 2, 3])
    tg = TaskGraph(tasks=[Task(id="t1", description="primary widget", status="ACTIVE", abstraction_level=0)])
    result = run_one_iteration(
        world_model=wm,
        diagnostics=_healthy_diagnostics(),
        hypothesis_set=HypothesisSet(active=[], eliminated=[]),
        task_graph=tg,
        failure_diagnostics=FailureDiagnostics(),
        memory_state=MemoryState(),
        strategy_state=ss,
        recovery_budget=recovery_budget,
        harness_run_state=harness_run_state,
        run_id="run-s6",
        step_count=0,
        supervisor_directive=directive,
    )
    return result, result.get("strategy_state", ss), wm


def _abort(rationale="redirection exhausted — unrecoverable") -> SupervisorDirective:
    return SupervisorDirective(action="ABORT", rationale=rationale)


# ── ABORT → escalate ───────────────────────────────────────────────────────────


def test_abort_escalates_without_run_state(monkeypatch):
    r, ss, _wm = _run(_abort(), monkeypatch=monkeypatch)
    assert r.get("escalated") is True
    assert r["escalation"]["reason"] == "cannot_make_progress"
    assert "redirection exhausted" in r["escalation"]["current_task_summary"]
    # ABORT does not run the deterministic ladder this iteration.
    assert ss.current_strategy == "DIRECT_EDIT"
    assert ss.switch_count == 0


def test_abort_escalates_via_escalate_when_run_state_present(monkeypatch):
    state = _MockHarnessRunState()
    r, _ss, _wm = _run(_abort(), harness_run_state=state, monkeypatch=monkeypatch)
    assert r.get("escalated") is True
    assert r["escalation"]["reason"] == "cannot_make_progress"
    assert state.escalation_pending is True
    assert state.pending_escalation is not None
    assert state.pending_escalation.reason == "cannot_make_progress"


def test_abort_records_switch_trigger(monkeypatch):
    _r, ss, _wm = _run(_abort(), monkeypatch=monkeypatch)
    assert any("supervisor:ABORT" in t for t in ss.switch_triggers)


def test_abort_flag_off_is_inert(monkeypatch):
    monkeypatch.delenv("HARNESS_TRAJECTORY_SUPERVISOR", raising=False)
    r, ss, _wm = _run(_abort(), monkeypatch=None)
    assert r.get("escalated") is not True
    # Falls through to the unchanged ladder: DIRECT_EDIT → TRACE_EXEC.
    assert ss.current_strategy == "TRACE_EXEC"


def test_abort_ignored_when_not_stalled(monkeypatch):
    ss = StrategyState(completion_history=[1, 2, 3])
    r, out_ss, _wm = _run(_abort(), stalled=False, strategy_state=ss, monkeypatch=monkeypatch)
    assert r.get("escalated") is not True
    assert out_ss.current_strategy == "DIRECT_EDIT"
    assert not any("supervisor" in t for t in out_ss.switch_triggers)


def test_abort_blocker_carries_no_raw_dumps(monkeypatch):
    r, _ss, _wm = _run(_abort("something went wrong"), monkeypatch=monkeypatch)
    esc = r["escalation"]
    assert set(esc.keys()) <= {"reason", "missing_info", "current_task_summary", "escalated_at", "question", "options"}
    blob = repr(esc)
    for leaked in ("beliefs", "hypothesis_set", "evidence_store", "generation_id", "derived_from"):
        assert leaked not in blob
    assert len(esc["current_task_summary"]) <= 500


def test_abort_still_escalates_when_budget_exhausted(monkeypatch):
    # An already-exhausted recovery budget escalates on the plain stall path first
    # (budget_exhausted); either way the run halts rather than looping.
    budget = RecoveryBudget(max_plan_revisions=3, plan_revisions_used=3)
    r, _ss, _wm = _run(_abort(), recovery_budget=budget, monkeypatch=monkeypatch)
    assert r.get("escalated") is True


# ── Q3 (a): the supervisor never influences resolve_control_state() ────────────


def test_q3_supervisor_absent_from_resolve_control_state_signature():
    """Q3 resolved (a): resolve_control_state() takes no supervisor / directive input —
    the supervisor path is a strategy / escalation move only, never a resolver write."""
    params = list(inspect.signature(resolve_control_state).parameters)
    assert not any("supervisor" in p or "directive" in p for p in params)
