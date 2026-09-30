"""
Local vs global replanning — P6.4.

Contradiction scope drives replan routing. LOCAL: re-queue current_task and
direct dependents. GLOBAL: rebuild entire task_graph from world_model + caller_state,
always followed by validate_task_graph().
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Any, Literal

from .recovery import StrategyState, StrategyType
from .task_graph import Task, TaskGraph, validate_task_graph

if TYPE_CHECKING:
    pass

ReplanScope = Literal["LOCAL", "GLOBAL"]


def assess_replan_scope(contradiction: Any, task_graph: TaskGraph) -> ReplanScope:
    """Derive replan scope from contradiction.scope and task_graph state."""
    if not task_graph.tasks:
        return "GLOBAL"
    scope = getattr(contradiction, "scope", "")
    if scope == "global":
        return "GLOBAL"
    return "LOCAL"


def diagnose_and_replan(
    current_task: Any,
    task_graph: TaskGraph,
    world_model: Any = None,
) -> TaskGraph:
    """LOCAL replan (TS diagnoseAndReplan): every not-yet-COMPLETE task that depends on the current task goes back to
    PENDING, then FAILED dependents are dropped (none are left after the reset, exactly as in TS)."""
    current_id: str = getattr(current_task, "id", "")

    for task in task_graph.tasks:
        if current_id in getattr(task, "depends_on", []) and task.status != "COMPLETE":
            task.status = "PENDING"

    task_graph.tasks = [
        t for t in task_graph.tasks if not (t.status == "FAILED" and current_id in getattr(t, "depends_on", []))
    ]
    task_graph.changed = True
    return task_graph


def requeue_failed_leaves(task_graph: TaskGraph) -> bool:
    """Flip FAILED leaf tasks (no non-FAILED task depends on them) back to PENDING (TS requeueFailedLeaves).

    A REDIRECT_STRATEGY directive, or a completed GATHER_EVIDENCE investigation, is a "retry this task differently"
    signal — but the LOCAL replan only re-queues *dependents* of the failed task, so on a one-node turn graph nothing
    lands PENDING. Re-queueing the failed leaf itself closes that loop. Returns True iff a task was re-queued.
    """
    ids_with_live_dependents: set[str] = {
        dep for t in task_graph.tasks if t.status != "FAILED" for dep in getattr(t, "depends_on", [])
    }
    changed = False
    for t in task_graph.tasks:
        if t.status == "FAILED" and t.id not in ids_with_live_dependents:
            t.status = "PENDING"
            changed = True
    if changed:
        task_graph.changed = True
    return changed


def rebuild_task_graph(world_model: Any, caller_state: Any, plan_note: str | None = None) -> TaskGraph:
    """GLOBAL replan (TS rebuildTaskGraph): a fresh TaskGraph from success_criteria (abstraction level 1, MEDIUM
    risk) plus one `Verify: <statement>` task per each of the first five beliefs (abstraction level 2, LOW risk).

    `plan_note` (Trajectory Supervisor REFRAME_PLAN) is appended to the success criteria as `Reframe: <note>`.
    """
    success_criteria: list[str] = list(getattr(caller_state, "success_criteria", []) or [])
    if plan_note:
        success_criteria = [*success_criteria, f"Reframe: {plan_note}"]
    beliefs: list[Any] = getattr(world_model, "beliefs", [])

    new_tasks: list[Task] = [
        Task(
            id=f"rebuilt-task-{i}-{uuid.uuid4().hex[:4]}",
            description=str(criterion),
            status="PENDING",
            depends_on=[],
            risk_level="MEDIUM",
            abstraction_level=1,
        )
        for i, criterion in enumerate(success_criteria)
    ]
    new_tasks.extend(
        Task(
            id=f"belief-verify-{i}-{uuid.uuid4().hex[:4]}",
            description=f"Verify: {belief.statement[:120]}",
            status="PENDING",
            depends_on=[],
            risk_level="LOW",
            abstraction_level=2,
        )
        for i, belief in enumerate(beliefs[:5])
    )
    return TaskGraph(tasks=new_tasks, changed=True)


FAILURE_MODE_BIAS_MIN_CONFIDENCE = 0.7


@dataclass
class RollbackReplanResult:
    rolled_back: bool
    cannot_progress: bool
    new_strategy_state: StrategyState
    new_task_graph: TaskGraph
    replan_scope: ReplanScope | None
    failure_mode_switch: dict[str, str] | None = None


def rollback_and_replan(
    current_task: Any,
    strategy_state: StrategyState,
    failure_diagnostics: Any,
    task_graph: TaskGraph,
    world_model: Any,
    caller_state: Any,
    experience_store: Any | None,
    rollback_fn: Callable[[], None] | None = None,
    supervisor_directive: Any | None = None,
    requeue_leaf_on_local: bool = False,
) -> RollbackReplanResult:
    """Handle a failed task (TS rollbackAndReplan): roll back, record the failure, decide GLOBAL vs LOCAL replan.

    * the failure goes into `failure_diagnostics.failure_history` (class from the matched pattern, else "unknown");
    * `cannot_make_progress` decides the scope: a stall (or a supervisor REFRAME_PLAN) rebuilds the graph GLOBALly,
      anything else re-queues dependents LOCALly;
    * the next strategy is, in order of precedence, a supervisor REDIRECT_STRATEGY hint, a confident failure-mode
      affinity (>= 0.7), then the next entry of the (experience-ordered) strategy ladder; REFRAME_PLAN keeps the
      current strategy and only records a switch trigger.
    """
    from .experience_store import build_strategy_ordering
    from .failure_modes import FailureRecord
    from .progress import cannot_make_progress
    from .recovery import STRATEGY_ORDER

    if rollback_fn is not None:
        rollback_fn()

    matched = failure_diagnostics.matched_pattern
    failure_diagnostics.failure_history.append(
        FailureRecord(
            failure_class=matched.failure_class if matched is not None else "unknown",
            description=f"Task failed: {current_task.description}",
            context={"task_id": current_task.id},
        )
    )

    no_progress = cannot_make_progress(strategy_state, failure_diagnostics)
    failure_class = matched.failure_class if matched is not None else ""

    action = getattr(supervisor_directive, "action", None)
    plan_note = getattr(supervisor_directive, "plan_note", None)
    strategy_hint = getattr(supervisor_directive, "strategy_hint", None)
    rationale = getattr(supervisor_directive, "rationale", "") or ""

    is_reframe = action == "REFRAME_PLAN" and bool(plan_note)
    redirect_hint = (
        strategy_hint
        if (not is_reframe and action == "REDIRECT_STRATEGY" and strategy_hint and strategy_hint in STRATEGY_ORDER)
        else None
    )
    failure_mode_hint = (
        matched.strategy_affinity
        if (
            not redirect_hint
            and not is_reframe
            and matched is not None
            and matched.confidence >= FAILURE_MODE_BIAS_MIN_CONFIDENCE
            and matched.strategy_affinity
            and matched.strategy_affinity in STRATEGY_ORDER
        )
        else None
    )

    if experience_store is not None and experience_store.available:
        ordering = build_strategy_ordering(failure_class, experience_store)
    else:
        ordering = list(STRATEGY_ORDER)

    def sup_trigger(tag: str) -> str:
        return f"supervisor:{tag} {rationale}".strip()[:200]

    failure_mode_switch: dict[str, str] | None = None
    if is_reframe:
        new_state = replace(
            strategy_state,
            switch_triggers=[*strategy_state.switch_triggers, sup_trigger("REFRAME_PLAN")],
            completion_history=list(strategy_state.completion_history),
            risk_state_history=list(strategy_state.risk_state_history),
        )
    else:
        try:
            idx = ordering.index(strategy_state.current_strategy)
        except ValueError:
            idx = -1
        next_strategy: StrategyType = redirect_hint or failure_mode_hint or ordering[min(idx + 1, len(ordering) - 1)]  # type: ignore[assignment]
        if not redirect_hint and failure_mode_hint and matched is not None:
            failure_mode_switch = {"failure_class": matched.failure_class, "strategy": failure_mode_hint}
        if redirect_hint:
            trigger = sup_trigger("REDIRECT_STRATEGY")
        elif failure_mode_hint:
            trigger = f"failure_mode:{matched.failure_class} -> {failure_mode_hint}"
        else:
            trigger = f"task_failed: {current_task.id}"
        new_state = replace(
            strategy_state,
            current_strategy=next_strategy,
            switch_count=strategy_state.switch_count + 1,
            switch_triggers=[*strategy_state.switch_triggers, trigger],
            completion_history=list(strategy_state.completion_history),
            risk_state_history=list(strategy_state.risk_state_history),
        )

    if is_reframe:
        scope: ReplanScope = "GLOBAL"
        new_graph = rebuild_task_graph(world_model, caller_state, plan_note)
        errors = validate_task_graph(new_graph)
        if errors:
            raise ValueError(f"Rebuilt task graph is invalid: {errors}")
    elif no_progress:
        scope = "GLOBAL"
        new_graph = rebuild_task_graph(world_model, caller_state)
        errors = validate_task_graph(new_graph)
        if errors:
            raise ValueError(f"Rebuilt task graph is invalid: {errors}")
    else:
        scope = "LOCAL"
        new_graph = diagnose_and_replan(current_task, task_graph)
        if (requeue_leaf_on_local or failure_mode_switch) and not any(t.status == "PENDING" for t in new_graph.tasks):
            if requeue_failed_leaves(new_graph):
                new_state.switch_triggers.append(sup_trigger("requeue_leaf"))

    return RollbackReplanResult(
        rolled_back=True,
        cannot_progress=no_progress,
        new_strategy_state=new_state,
        new_task_graph=new_graph,
        replan_scope=scope,
        failure_mode_switch=failure_mode_switch,
    )


def apply_replan(
    scope: ReplanScope,
    contradiction: Any,
    current_task: Any,
    task_graph: TaskGraph,
    world_model: Any,
    caller_state: Any,
    plan_note: str | None = None,
) -> TaskGraph:
    """Route to local or global replan. GLOBAL always validates before returning.

    ``plan_note`` is only meaningful for a GLOBAL replan (Supervisor REFRAME_PLAN, S1).
    """
    if scope == "LOCAL":
        return diagnose_and_replan(current_task, task_graph, world_model)

    # Pass plan_note only when set, so a monkeypatched/legacy rebuild_task_graph stub
    # (no plan_note param) keeps working for every existing GLOBAL-replan caller.
    new_graph = (
        rebuild_task_graph(world_model, caller_state, plan_note=plan_note)
        if plan_note
        else rebuild_task_graph(world_model, caller_state)
    )
    errors = validate_task_graph(new_graph)
    if errors:
        raise ValueError(f"Rebuilt task graph is invalid: {errors}")
    return new_graph
