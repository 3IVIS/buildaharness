"""
S8 of plans/harness_trajectory_supervisor_plan.html — lever 1: close the
single-node re-queue loop.

Before S8, only REFRAME_PLAN could recover a stall on a one-node turn graph: the
LOCAL replan path (``diagnose_and_replan``) re-queues only *dependents* of the
failed task, so on a single-node graph nothing lands PENDING and the redirected
strategy / freshly gathered evidence is never applied — the S7 benchmark came back
NEUTRAL for exactly this reason.

``requeue_failed_leaves`` (harness/replanning.py) flips FAILED leaf tasks back to
PENDING. run_one_iteration() calls it on the REDIRECT_STRATEGY stall edge when the
LOCAL replan left nothing runnable; planner_api.py calls it on the GATHER_EVIDENCE
investigation re-entry. INV-21: task_graph only, never control_state. Bounded by
recovery_budget + switch_count -> strategy loop.

Run: pytest adapter/tests/test_harness_supervisor_s8.py -q --noconftest
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

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
from harness.replanning import requeue_failed_leaves
from harness.supervisor import SupervisorDirective
from harness.task_graph import Task, TaskGraph
from harness.world_model import Belief, Observation, WorldModel

STALL_HISTORY = [0, 0, 0, 0, 0, 0]


def _healthy_diagnostics() -> Diagnostics:
    return Diagnostics(
        belief_health=BeliefHealth(freshness=0.9, consistency=0.9, support=0.9),
        coverage_health=CoverageHealth(symptom_coverage=0.9, explanation_coverage=0.9),
        verification_health=VerificationHealth(strength=0.9, feasibility=0.9),
        execution_health=ExecutionHealth(progress_rate=0.9, failure_recurrence=0.1, oscillation_score=0.1),
    )


class _CallerState:
    def __init__(self, success_criteria: list[str]):
        self.success_criteria = success_criteria
        self.constraints_changed = False


def _run(directive, *, tasks, caller_state, recovery_budget=None, strategy_state=None, monkeypatch=None):
    if monkeypatch is not None:
        monkeypatch.setenv("HARNESS_TRAJECTORY_SUPERVISOR", "1")
    wm = WorldModel()
    wm.add_observation(Observation(id="o0", content="obs", source="test"))
    wm.add_belief(Belief(id="b0", statement="belief 0", confidence=0.8, derived_from=["o0"]))
    ss = strategy_state or StrategyState(completion_history=list(STALL_HISTORY))
    tg = TaskGraph(tasks=tasks)
    result = run_one_iteration(
        world_model=wm,
        diagnostics=_healthy_diagnostics(),
        hypothesis_set=HypothesisSet(active=[], eliminated=[]),
        task_graph=tg,
        failure_diagnostics=FailureDiagnostics(),
        memory_state=MemoryState(),
        strategy_state=ss,
        caller_state=caller_state,
        recovery_budget=recovery_budget,
        step_count=0,
        supervisor_directive=directive,
    )
    return result, result.get("strategy_state", ss), result.get("task_graph", tg), wm


def _redirect(hint="REIMPLEMENT") -> SupervisorDirective:
    return SupervisorDirective(action="REDIRECT_STRATEGY", rationale="pivot the approach", strategy_hint=hint)


# ── requeue_failed_leaves unit behaviour ──────────────────────────────────────


def test_requeue_flips_a_lone_failed_leaf():
    tg = TaskGraph(tasks=[Task(id="t1", description="only task", status="FAILED", abstraction_level=0)])
    assert requeue_failed_leaves(tg) is True
    assert tg.tasks[0].status == "PENDING"
    assert tg.changed is True


def test_requeue_leaves_a_failed_task_with_a_live_dependent_alone():
    tg = TaskGraph(
        tasks=[
            Task(id="a", description="upstream", status="FAILED", abstraction_level=0),
            Task(id="b", description="downstream", status="PENDING", depends_on=["a"], abstraction_level=0),
        ]
    )
    assert requeue_failed_leaves(tg) is False
    assert tg.tasks[0].status == "FAILED"


def test_requeue_is_noop_when_nothing_failed():
    tg = TaskGraph(tasks=[Task(id="t1", description="x", status="COMPLETE", abstraction_level=0)])
    assert requeue_failed_leaves(tg) is False


# ── REDIRECT_STRATEGY on a one-node stall now re-queues the leaf ──────────────


def test_redirect_requeues_failed_leaf_on_single_node_graph(monkeypatch):
    cs = _CallerState(["answer the question"])
    tasks = [Task(id="t1", description="respond", status="FAILED", abstraction_level=0)]
    _r, ss, tg, _wm = _run(_redirect(), tasks=tasks, caller_state=cs, monkeypatch=monkeypatch)
    assert tg.tasks[0].status == "PENDING"
    assert ss.current_strategy == "REIMPLEMENT"
    assert any("supervisor:requeue_leaf" in t for t in ss.switch_triggers)


def test_redirect_does_not_requeue_when_a_pending_task_exists(monkeypatch):
    cs = _CallerState(["answer the question"])
    tasks = [
        Task(id="t1", description="failed", status="FAILED", abstraction_level=0),
        Task(id="t2", description="still runnable", status="PENDING", abstraction_level=0),
    ]
    _r, ss, tg, _wm = _run(_redirect(), tasks=tasks, caller_state=cs, monkeypatch=monkeypatch)
    assert tg.tasks[0].status == "FAILED"
    assert not any("supervisor:requeue_leaf" in t for t in ss.switch_triggers)


def test_flag_off_no_requeue(monkeypatch):
    monkeypatch.delenv("HARNESS_TRAJECTORY_SUPERVISOR", raising=False)
    cs = _CallerState(["answer the question"])
    tasks = [Task(id="t1", description="respond", status="FAILED", abstraction_level=0)]
    _r, ss, tg, _wm = _run(_redirect(), tasks=tasks, caller_state=cs, monkeypatch=None)
    assert tg.tasks[0].status == "FAILED"
    assert not any("requeue_leaf" in t for t in ss.switch_triggers)


def test_continue_directive_does_not_requeue(monkeypatch):
    cs = _CallerState(["answer the question"])
    tasks = [Task(id="t1", description="respond", status="FAILED", abstraction_level=0)]
    d = SupervisorDirective(action="CONTINUE", rationale="keep going")
    _r, _ss, tg, _wm = _run(d, tasks=tasks, caller_state=cs, monkeypatch=monkeypatch)
    assert tg.tasks[0].status == "FAILED"


# ── boundedness ──────────────────────────────────────────────────────────────


def test_requeue_is_bounded_by_recovery_budget(monkeypatch):
    # A REDIRECT that keeps re-queueing still consumes a plan revision each stall edge,
    # so a finite RecoveryBudget forces a terminal state rather than an unbounded loop.
    cs = _CallerState(["answer the question"])
    budget = RecoveryBudget(max_plan_revisions=2)
    ss = StrategyState(completion_history=list(STALL_HISTORY))
    for _ in range(6):
        tasks = [Task(id="t1", description="respond", status="FAILED", abstraction_level=0)]
        r, ss, _tg, _wm = _run(
            _redirect(),
            tasks=tasks,
            caller_state=cs,
            recovery_budget=budget,
            strategy_state=ss,
            monkeypatch=monkeypatch,
        )
        budget = r.get("recovery_budget", budget)
        if r.get("escalated"):
            break
    assert budget.plan_revisions_used <= budget.max_plan_revisions
