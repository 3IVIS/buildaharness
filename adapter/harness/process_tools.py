"""
Agent-driven process tools — P-PC.8.

Four harness tool functions that let the running agent inspect the concept
catalog, pick a concept, and advance through its steps during execution.
All functions are side-effect-free except load_process() and complete_step(),
which mutate the task_graph in-place.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .task_graph import TaskGraph, select_unblocked_leaf

if TYPE_CHECKING:
    from .process_registry import ProcessRegistry


def list_processes(registry: ProcessRegistry) -> list[dict[str, Any]]:
    """Return summary metadata for every concept in registry, sorted by ID.

    Each entry contains enough for the agent to pick a concept without loading
    the full definition: ``id``, ``name``, ``description``, ``step_count``.
    """
    results: list[dict[str, Any]] = []
    for concept_id in registry.list_available():
        concept = registry.load(concept_id)
        results.append(
            {
                "id": concept.id,
                "name": concept.name,
                "description": concept.description,
                "step_count": len(concept.steps),
            }
        )
    return results


def load_process(
    concept_id: str,
    task_graph: TaskGraph,
    registry: ProcessRegistry,
) -> dict[str, Any]:
    """Load a concept and seed the task graph; idempotent on the same concept.

    If tasks namespaced under ``concept_id`` already exist in the graph, the
    graph is not modified — the current first step is returned instead
    (INV-PC-05).

    Raises ProcessConceptNotFoundError for an unregistered concept_id.
    Returns ``{concept_id, seeded_steps, first_step}`` where ``first_step``
    is the result of get_current_step() — None if no PENDING task is ready.
    """
    concept = registry.load(concept_id)

    namespace_prefix = f"{concept_id}:"
    already_seeded = any(t.id.startswith(namespace_prefix) for t in task_graph.tasks)

    if not already_seeded:
        concept.seed_task_graph(task_graph)

    return {
        "concept_id": concept_id,
        "seeded_steps": len(concept.steps),
        "first_step": get_current_step(task_graph),
    }


def get_current_step(task_graph: TaskGraph) -> dict[str, Any] | None:
    """Return the next actionable task, or None when all steps are done.

    Delegates to select_unblocked_leaf() — the highest-priority PENDING task
    whose depends_on are all COMPLETE. Returns None when the process is
    complete or fully blocked (INV-PC-06).
    """
    task = select_unblocked_leaf(task_graph)
    if task is None:
        return None
    return {
        "id": task.id,
        "description": task.description,
        "risk_level": task.risk_level,
        "expected_tools": [],
        "success_criteria": [],
    }


def complete_step(step_id: str, task_graph: TaskGraph) -> dict[str, Any]:
    """Mark a task COMPLETE and return the next unblocked step.

    Only the named task is mutated — dependency unlocking is emergent on the
    next get_current_step() call (INV-PC-07). Raises ValueError when step_id
    does not exist or the task is already COMPLETE.
    """
    task_by_id = {t.id: t for t in task_graph.tasks}
    task = task_by_id.get(step_id)

    if task is None:
        raise ValueError(f"step_id {step_id!r} not found in task graph")
    if task.status == "COMPLETE":
        raise ValueError(f"step_id {step_id!r} is already COMPLETE")

    task.status = "COMPLETE"
    task_graph.changed = True

    return {
        "completed": step_id,
        "next_step": get_current_step(task_graph),
    }
