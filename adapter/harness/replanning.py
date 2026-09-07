"""
Local vs global replanning — P6.4.

Contradiction scope drives replan routing. LOCAL: re-queue current_task and
direct dependents. GLOBAL: rebuild entire task_graph from world_model + caller_state,
always followed by validate_task_graph().
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING, Any, Literal

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
    world_model: Any,
) -> TaskGraph:
    """LOCAL replan: re-queue current_task dependents and remove FAILED downstreams."""
    current_id: str = getattr(current_task, "id", "")

    for task in task_graph.tasks:
        deps = getattr(task, "depends_on", [])
        if current_id in deps:
            task.status = "PENDING"
            task.block_reason = None

    task_graph.tasks = [
        t for t in task_graph.tasks if not (t.status == "FAILED" and current_id in getattr(t, "depends_on", []))
    ]
    task_graph.changed = True
    return task_graph


def requeue_failed_leaves(task_graph: TaskGraph) -> bool:
    """Flip FAILED leaf tasks (no non-FAILED task depends on them) back to PENDING.

    Trajectory Supervisor lever 1 (S8). A REDIRECT_STRATEGY directive, or a completed
    GATHER_EVIDENCE investigation, is a "retry this task differently" signal — but the
    LOCAL replan path (``diagnose_and_replan``) only re-queues *dependents* of the failed
    task. On a one-node turn graph (every single-turn personal-assistant run) nothing
    lands PENDING, so the redirected strategy / freshly gathered evidence is never
    applied and the run stalls out. Re-queueing the failed leaf itself closes that loop.

    Bounded by the caller: ``recovery_budget`` plan-revision consumption on every stall
    edge, ``switch_count`` -> ``strategy_looping`` after MAX_SWITCHES, and the per-run
    investigation cap K. Returns True iff at least one task was re-queued.
    """
    ids_with_live_dependents: set[str] = {
        dep for t in task_graph.tasks if t.status != "FAILED" for dep in getattr(t, "depends_on", [])
    }
    changed = False
    for t in task_graph.tasks:
        if t.status == "FAILED" and t.id not in ids_with_live_dependents:
            t.status = "PENDING"
            t.block_reason = None
            changed = True
    if changed:
        task_graph.changed = True
    return changed


def rebuild_task_graph(world_model: Any, caller_state: Any, plan_note: str | None = None) -> TaskGraph:
    """GLOBAL replan: fresh TaskGraph from success_criteria + world_model beliefs.

    ``plan_note`` (Trajectory Supervisor REFRAME_PLAN, S1) is an extra reframing
    constraint appended to the success criteria before decomposition. None for every
    existing caller — no behaviour change.
    """
    success_criteria: list[str] = list(getattr(caller_state, "success_criteria", []))
    if plan_note:
        success_criteria = [*success_criteria, f"Reframe: {plan_note}"]
    beliefs: list[Any] = getattr(world_model, "beliefs", [])

    new_tasks: list[Task] = []
    for criterion in success_criteria:
        new_tasks.append(
            Task(
                id=str(uuid.uuid4()),
                description=str(criterion),
                status="PENDING",
                depends_on=[],
                risk_level="MEDIUM",
            )
        )

    for belief in beliefs[:5]:
        statement = getattr(belief, "statement", "")
        if statement:
            new_tasks.append(
                Task(
                    id=str(uuid.uuid4()),
                    description=f"Verify: {statement[:120]}",
                    status="PENDING",
                    depends_on=[],
                    risk_level="LOW",
                )
            )

    return TaskGraph(tasks=new_tasks, changed=True)


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
