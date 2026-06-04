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
    from .caller_state import CallerState
    from .world_model import WorldModel

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
        t
        for t in task_graph.tasks
        if not (t.status == "FAILED" and current_id in getattr(t, "depends_on", []))
    ]
    task_graph.changed = True
    return task_graph


def rebuild_task_graph(world_model: Any, caller_state: Any) -> TaskGraph:
    """GLOBAL replan: fresh TaskGraph from success_criteria + world_model beliefs."""
    success_criteria: list[str] = getattr(caller_state, "success_criteria", [])
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
) -> TaskGraph:
    """Route to local or global replan. GLOBAL always validates before returning."""
    if scope == "LOCAL":
        return diagnose_and_replan(current_task, task_graph, world_model)

    new_graph = rebuild_task_graph(world_model, caller_state)
    errors = validate_task_graph(new_graph)
    if errors:
        raise ValueError(f"Rebuilt task graph is invalid: {errors}")
    return new_graph
