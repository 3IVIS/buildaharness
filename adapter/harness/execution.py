"""Execution engine with reversibility strategies — P5.4.

Twin of packages/harness/src/nodes/execute.ts. `execute()` picks a reversibility strategy from the change type,
records a rollback point, runs the tool, and records the outcome: a failure becomes SYSTEM_ERROR evidence plus a
world-model observation and fails the task (as the execution layer); every run appends an environment-change entry.
"""

from __future__ import annotations

import inspect
import json
import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

from .lexical_off import harness_lexical_active

ReversibilityStrategy = Literal["snapshot", "git-revert", "patch-rollback", "ephemeral"]
ExecutionStatus = Literal["continue", "complete", "failed"]

UNVERIFIED_EDGE_RATIO_THRESHOLD = 0.5

_EXECUTION_STATUSES = ("continue", "complete", "failed")


class HarnessPauseSignal(Exception):
    """Raised by a tool to suspend the run (TS `{__harnessPause: true}` throw). execute() records the environment
    change, then re-raises it for the driver to turn into a paused run."""


def _classify_system_error_symptom(message: str) -> str | None:
    """Map a raw error message to a canonical short symptom phrase (TS classifySystemErrorSymptom).

    Raw error text (e.g. a Python OSError's "No such file or directory") rarely shares literal vocabulary with a
    curated FailureModeEntry symptom phrase (e.g. "file not found"), so this bridges the two before SYSTEM_ERROR
    evidence is written. Off (returns None, keeping the raw text) unless HARNESS_LEXICAL system-error-symptoms is on.
    """
    if not harness_lexical_active("system-error-symptoms"):
        return None
    m = message.lower()
    if "enoent" in m or "no such file or directory" in m:
        return "file not found"
    if "etimedout" in m or "timed out" in m or "timeout" in m:
        return "request timed out"
    if "econnrefused" in m or "connection refused" in m:
        return "connection refused"
    if "eacces" in m or "permission denied" in m:
        return "permission denied"
    if "enotfound" in m or "getaddrinfo" in m:
        return "host not found"
    if "econnreset" in m:
        return "connection reset"
    if "404" in m or "not found" in m:
        return "not found"
    if "401" in m or "403" in m or "unauthorized" in m or "forbidden" in m:
        return "access denied"
    if re.search(r"\b5\d{2}\b", m) or "internal server error" in m:
        return "server error"
    if "exited with code" in m or re.search(r"non-?zero exit", m):
        return "command failed"
    return None


@dataclass
class ExecutionResult:
    success: bool
    output: Any = None
    error: str | None = None
    strategy: ReversibilityStrategy = "ephemeral"
    rollback_ref: str | None = None
    status: ExecutionStatus = "complete"
    # Why a failed execution failed (TS failure_kind): "system_error" (the executor raised, or reported a failure
    # without a kind — the tool or model call broke) or "exhausted" (it ran out of its own iteration budget).
    # None when it did not fail.
    failure_kind: str | None = None


@dataclass
class ToolExecutorContext:
    world_model: Any
    evidence_store: Any
    control_state: Any = None
    diagnostics: Any = None
    failure_diagnostics: Any = None
    current_task_id: str | None = None


def select_reversibility_strategy(proposed_change: Any, task_risk: str | None = None) -> ReversibilityStrategy:
    """Reversibility strategy from the change type alone (TS selectReversibilityStrategy).

    read-only -> "ephemeral"; schema / infra -> "snapshot"; anything else (file mutation) -> "patch-rollback".
    `task_risk` is accepted for older callers and ignored.
    """
    change_type = _get_change_type(proposed_change)
    if change_type == "read-only":
        return "ephemeral"
    if change_type in ("schema", "infra"):
        return "snapshot"
    return "patch-rollback"


def _make_ref() -> str:
    return uuid.uuid4().hex[:8]


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _description(proposed_change: Any, default: str) -> str:
    if isinstance(proposed_change, dict):
        return str(proposed_change.get("description") or default)
    return str(getattr(proposed_change, "description", None) or default)


def _continuable(value: Any) -> str | None:
    if isinstance(value, dict) and value.get("__harnessExecutionStatus") in _EXECUTION_STATUSES:
        return value["__harnessExecutionStatus"]
    return None


def execute(
    proposed_change: Any,
    tool_workflow: Any,
    world_model: Any,
    task_graph: Any,
    current_task: Any,
    evidence_store: Any,
    *,
    memory_state: Any = None,
    belief_dep_graph: Any = None,
    plan_tool_workflow: Any = None,
    control_state: Any = None,
    diagnostics: Any = None,
    failure_diagnostics: Any = None,
) -> ExecutionResult:
    """Run `tool_workflow` for the current task (TS execute).

    * a rollback point is recorded on `memory_state` for every strategy but "ephemeral" (a `snapshot` also stores the
      serialised world model);
    * `plan_tool_workflow()` runs first when the belief graph's unverified-edge ratio exceeds 0.5;
    * `tool_workflow` may take a ToolExecutorContext (`tool_workflow(ctx)`) or no arguments; it may return a
      "continuable" outcome dict `{"__harnessExecutionStatus": "continue"|"complete"|"failed", ...}`;
    * a raised exception (or a "failed" outcome) writes SYSTEM_ERROR evidence + a world-model observation and fails
      the task as the execution layer; a HarnessPauseSignal is re-raised after the environment change is recorded.
    """
    from .evidence import Evidence
    from .task_graph import TaskOutcome, apply_task_outcome
    from .world_model import Observation

    strategy = select_reversibility_strategy(proposed_change)
    task_id = str(getattr(current_task, "id", "") or "")
    rollback_ref: str | None = None

    if strategy != "ephemeral":
        rollback_ref = f"{strategy}-{_make_ref()}"
        if memory_state is not None:
            from .memory import RollbackPoint

            memory_state.rollback_points.append(
                RollbackPoint(
                    id=rollback_ref,
                    step=len(memory_state.rollback_points),
                    description=_description(proposed_change, "snapshot" if strategy == "snapshot" else strategy),
                    serialised_state=json.dumps(world_model.to_dict()) if strategy == "snapshot" else "",
                )
            )

    if (
        belief_dep_graph is not None
        and belief_dep_graph.unverified_edge_ratio > UNVERIFIED_EDGE_RATIO_THRESHOLD
        and plan_tool_workflow is not None
    ):
        plan_tool_workflow()

    output: Any = None
    error: str | None = None
    success = False
    status: ExecutionStatus = "failed"
    failure_kind: str | None = None

    def record_failure(message: str) -> None:
        symptom = _classify_system_error_symptom(message)
        if evidence_store is not None:
            evidence_store.add_observation(
                Evidence(
                    id=f"sys-err-{_make_ref()}",
                    obs=f"{symptom} — Tool execution failed: {message}"
                    if symptom
                    else f"Tool execution failed: {message}",
                    reliability="HIGH",
                    source="execution_engine",
                    evidence_type="SYSTEM_ERROR",
                    freshness=_now(),
                )
            )
        if world_model is not None:
            world_model.observations.append(
                Observation(id=f"err-obs-{_make_ref()}", content=f"SYSTEM_ERROR: {message}", source="execution_engine")
            )
        if task_graph is not None and task_id:
            try:
                apply_task_outcome(task_graph, task_id, TaskOutcome(status="FAILED", from_execution_layer=True))
            except ValueError:
                pass  # already terminal / unknown task

    def log_change() -> None:
        if world_model is not None:
            world_model.environment_change_log.append(
                {
                    "id": f"change-{_make_ref()}",
                    "description": _description(proposed_change, "execution"),
                    "affected_paths": [],
                    "timestamp": _now(),
                }
            )

    try:
        if callable(tool_workflow):
            takes_ctx = any(
                p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD) and p.default is p.empty
                for p in inspect.signature(tool_workflow).parameters.values()
            )
            raw = (
                tool_workflow(
                    ToolExecutorContext(
                        world_model=world_model,
                        evidence_store=evidence_store,
                        control_state=control_state,
                        diagnostics=diagnostics,
                        failure_diagnostics=failure_diagnostics,
                        current_task_id=task_id or None,
                    )
                )
                if takes_ctx
                else tool_workflow()
            )
        else:
            raw = tool_workflow
        continuable = _continuable(raw)
        if continuable is not None:
            status = continuable  # type: ignore[assignment]
            output = raw.get("output")
            success = status != "failed"
            if status == "failed":
                error = raw.get("error") or "execution reported a failed status"
                failure_kind = "exhausted" if raw.get("__harnessFailureKind") == "exhausted" else "system_error"
                record_failure(error)
        else:
            output = raw
            success = True
            status = "complete"
    except HarnessPauseSignal:
        log_change()
        raise
    except Exception as exc:
        error = str(exc)
        status = "failed"
        failure_kind = "system_error"
        record_failure(error)

    log_change()

    return ExecutionResult(
        success=success,
        output=output,
        error=error,
        strategy=strategy,
        rollback_ref=rollback_ref,
        status=status,
        failure_kind=failure_kind,
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
