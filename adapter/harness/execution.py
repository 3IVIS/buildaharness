"""Execution engine with reversibility strategies — P5.4."""

from __future__ import annotations

import os
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

ReversibilityStrategy = Literal["snapshot", "git-revert", "patch-rollback", "ephemeral"]


@dataclass
class ExecutionResult:
    success: bool
    output: Any = None
    error: str | None = None
    strategy: ReversibilityStrategy = "ephemeral"
    rollback_ref: str | None = None


def select_reversibility_strategy(
    proposed_change: Any,
    task_risk: str,
) -> ReversibilityStrategy:
    """Select a reversibility strategy based on change type and risk level.

    - read-only → "ephemeral"
    - file mutation + LOW → "patch-rollback"
    - file mutation + MEDIUM/HIGH → "git-revert" if .git exists, else "snapshot"
    - schema/infra → "snapshot"
    """
    change_type = _get_change_type(proposed_change)

    if change_type == "read-only":
        return "ephemeral"

    if change_type in ("schema", "infra"):
        return "snapshot"

    # file mutation
    if task_risk == "LOW":
        return "patch-rollback"

    # MEDIUM or HIGH
    if _git_repo_exists():
        return "git-revert"
    return "snapshot"


def execute(
    proposed_change: Any,
    tool_workflow: Any,
    world_model: Any,
    task_graph: Any,
    current_task: Any,
    evidence_store: Any,
) -> ExecutionResult:
    """Execute the tool workflow, record results, and handle errors.

    On tool failure: creates Evidence(SYSTEM_ERROR, HIGH) and updates world model.
    Records successful execution in world_model.environment_change_log.
    """
    from .evidence import Evidence

    task_risk = str(getattr(current_task, "risk_level", "LOW"))
    strategy = select_reversibility_strategy(proposed_change, task_risk)

    # Generate a rollback reference for non-ephemeral strategies
    rollback_ref: str | None = None
    if strategy != "ephemeral":
        rollback_ref = f"{strategy}-{uuid.uuid4().hex[:8]}"

    # Transition task to ACTIVE if in PENDING state
    task_id = str(getattr(current_task, "id", "") or "")
    if task_graph is not None and task_id:
        task = task_graph.get_task(task_id) if hasattr(task_graph, "get_task") else None
        if task is not None and task.status == "PENDING":
            try:
                task_graph.update_task_status(task_id, "ACTIVE")
            except ValueError:
                pass  # already ACTIVE or invalid transition

    # Run the tool workflow
    try:
        if callable(tool_workflow):
            output = tool_workflow()
        else:
            output = tool_workflow
    except Exception as exc:
        error_msg = str(exc)
        # Create SYSTEM_ERROR evidence
        err_evidence = Evidence(
            id=f"sys-err-{uuid.uuid4().hex[:8]}",
            obs=f"Tool execution failed: {error_msg}",
            reliability="HIGH",
            source="execution_engine",
            evidence_type="SYSTEM_ERROR",
            freshness=1.0,
            recorded_at=datetime.now(UTC),
        )
        if evidence_store is not None and hasattr(evidence_store, "append"):
            evidence_store.append(err_evidence)

        # Update world model with error observation
        if world_model is not None:
            from .world_model import Observation

            err_obs = Observation(
                id=f"err-obs-{uuid.uuid4().hex[:8]}",
                content=f"SYSTEM_ERROR: {error_msg}",
                source="execution_engine",
            )
            if hasattr(world_model, "observations"):
                world_model.observations.append(err_obs)

        # Transition task to FAILED
        if task_graph is not None and task_id:
            task = task_graph.get_task(task_id) if hasattr(task_graph, "get_task") else None
            if task is not None and task.status == "ACTIVE":
                try:
                    task_graph.update_task_status(task_id, "FAILED")
                except ValueError:
                    pass

        return ExecutionResult(
            success=False,
            output=None,
            error=error_msg,
            strategy=strategy,
            rollback_ref=rollback_ref,
        )

    # Success path — record in environment_change_log
    if world_model is not None and hasattr(world_model, "environment_change_log"):
        world_model.environment_change_log.append(
            {
                "task_id": task_id,
                "strategy": strategy,
                "rollback_ref": rollback_ref,
                "timestamp": datetime.now(UTC).isoformat(),
                "status": "completed",
            }
        )

    # Transition task to VERIFYING
    if task_graph is not None and task_id:
        task = task_graph.get_task(task_id) if hasattr(task_graph, "get_task") else None
        if task is not None and task.status == "ACTIVE":
            try:
                task_graph.update_task_status(task_id, "VERIFYING")
            except ValueError:
                pass

    return ExecutionResult(
        success=True,
        output=output,
        error=None,
        strategy=strategy,
        rollback_ref=rollback_ref,
    )


def action_dep_overlap(action: Any, memory_state: Any) -> list[str]:
    """Check action.required_state_structures against memory_state compressed/pruned regions.

    Returns a list of overlapping structure names.
    """
    if memory_state is None:
        return []

    required: list[str] = []
    if isinstance(action, dict):
        required = list(action.get("required_state_structures", []))
    else:
        req = getattr(action, "required_state_structures", None)
        if req is not None:
            required = list(req)

    if not required:
        return []

    # Collect compressed and pruned structures from memory_state
    affected: set[str] = set()

    if isinstance(memory_state, dict):
        compressed = memory_state.get("compressed_structures", [])
        pruned = memory_state.get("pruned_regions", [])
    else:
        compressed = list(getattr(memory_state, "compressed_structures", []))
        pruned = list(getattr(memory_state, "pruned_regions", []))

    affected.update(_structure_id(s) for s in compressed)
    affected.update(_structure_id(r) for r in pruned)

    return [r for r in required if r in affected]


# ── Internal helpers ──────────────────────────────────────────────────────────


def _structure_id(item: Any) -> str:
    """Extract the string ID from a structure/region item (str, dict, or dataclass)."""
    if isinstance(item, str):
        return item
    if isinstance(item, dict):
        return item.get("id", str(item))
    return getattr(item, "id", str(item))


def _get_change_type(proposed_change: Any) -> str:
    """Extract change type from proposed change descriptor."""
    if isinstance(proposed_change, dict):
        return str(proposed_change.get("change_type", "file_mutation") or "file_mutation")
    ct = getattr(proposed_change, "change_type", None)
    if ct is not None:
        return str(ct)
    return "file_mutation"


def _git_repo_exists() -> bool:
    """Check if a .git directory exists in the current working directory or parents."""
    path = os.getcwd()
    while True:
        if os.path.exists(os.path.join(path, ".git")):
            return True
        parent = os.path.dirname(path)
        if parent == path:
            break
        path = parent
    return False
