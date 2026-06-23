"""Plan I/O and conversion layer for the plan-first agent.

Pure I/O and conversion — no reasoning logic. Default template directory
is resolved relative to this file so no environment variable is needed.
Save errors are swallowed and logged (never interrupt a running turn).
Load errors are raised immediately (startup-time contract failure).
"""

from __future__ import annotations

import json
import logging
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .plan_schema import PlanSnapshot, PlanTask, PlanTemplate, TaskStatusOverride, validate_template

logger = logging.getLogger(__name__)

# ── Directory constants ────────────────────────────────────────────────────────

DEFAULT_TEMPLATE_DIR: Path = (
    Path(__file__).parent.parent  # adapter/
    / "agents"
    / "planner"
    / "data"
    / "plan_templates"
)

DEFAULT_SNAPSHOT_DIR: Path = (
    Path(__file__).parent.parent.parent  # repo root
    / "agents"
    / "planner"
    / "snapshots"
)


# ── Custom exception ───────────────────────────────────────────────────────────


class PlanLoadError(ValueError):
    """Raised when a plan template cannot be loaded or parsed."""


# ── Public API ─────────────────────────────────────────────────────────────────


def list_plans(folder: Path = DEFAULT_TEMPLATE_DIR) -> list[str]:
    """Return stem names of valid PlanTemplate JSON files in folder, sorted.

    Excludes snapshot files (those have a 'run_id' field).
    """
    results: list[str] = []
    try:
        candidates = sorted(folder.glob("*.json"))
    except OSError:
        return results

    for path in candidates:
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        # Snapshots carry run_id — exclude them
        if "run_id" in raw:
            continue
        try:
            PlanTemplate.model_validate(raw)
            results.append(path.stem)
        except Exception:  # noqa: S112
            continue

    return results


def load_plan(name: str, folder: Path = DEFAULT_TEMPLATE_DIR) -> PlanTemplate:
    """Load and validate a named plan template from folder.

    Raises PlanLoadError (with filename in message) if the file is missing,
    unparseable, or fails DAG validation.
    """
    path = folder / f"{name}.json"

    if not path.exists():
        raise PlanLoadError(f"Plan template not found: {path}")

    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PlanLoadError(f"Cannot read/parse {path}: {exc}") from exc

    try:
        template = PlanTemplate.model_validate(raw)
    except Exception as exc:
        raise PlanLoadError(f"Invalid PlanTemplate in {path}: {exc}") from exc

    errors = validate_template(template)
    if errors:
        raise PlanLoadError(f"Template {path} failed validation: {'; '.join(errors)}")

    return template


def plan_to_task_graph(template: PlanTemplate) -> tuple[Any, str]:
    """Convert a PlanTemplate to a TaskGraph with all tasks PENDING.

    Returns (task_graph, success_criteria).
    Runs validate_task_graph() after conversion.
    """
    from .task_graph import Task, TaskGraph, validate_task_graph

    tasks = [
        Task(
            id=pt.id,
            description=pt.description,
            status="PENDING",
            depends_on=list(pt.depends_on),
            risk_level=pt.risk_level,
            abstraction_level=pt.abstraction_level,
            parallel_write_domains=list(pt.parallel_write_domains),
        )
        for pt in template.tasks
    ]

    tg = TaskGraph(tasks=tasks)
    errors = validate_task_graph(tg)
    if errors:
        raise PlanLoadError(f"plan_to_task_graph validation failed: {'; '.join(errors)}")

    return tg, template.success_criteria


def save_plan(
    run_id: str,
    turn: int,
    task_graph: Any,
    template: PlanTemplate,
    snapshot_dir: Path = DEFAULT_SNAPSHOT_DIR,
) -> bool:
    """Write an atomic snapshot of the current task_graph state.

    Never raises — logs a warning on I/O error and returns False.
    Returns True on success.
    """
    try:
        snapshot_dir.mkdir(parents=True, exist_ok=True)

        snapshot = task_graph_to_plan(task_graph, template, run_id=run_id, turn=turn)
        payload = snapshot.model_dump_json(indent=2)

        final = snapshot_dir / f"{run_id}_t{turn}.json"
        tmp = snapshot_dir / f"{run_id}_t{turn}.json.tmp"

        tmp.write_text(payload, encoding="utf-8")
        os.replace(tmp, final)
        return True

    except Exception as exc:
        logger.warning("plan_store.save_plan failed (run_id=%s, turn=%d): %s", run_id, turn, exc)
        return False


def task_graph_to_plan(
    task_graph: Any,
    base_template: PlanTemplate,
    run_id: str = "",
    turn: int = 0,
) -> PlanSnapshot:
    """Build a PlanSnapshot from a live TaskGraph and the original template.

    Tasks added by replanning (not in base_template) appear with
    metadata["replanned"] = True in the snapshot metadata.
    """
    template_ids = {pt.id for pt in base_template.tasks}
    tasks: list[PlanTask] = []
    statuses: list[TaskStatusOverride] = []

    for t in task_graph.tasks:
        plan_task = PlanTask(
            id=t.id,
            title=t.description.split(".")[0],
            description=t.description,
            depends_on=list(t.depends_on),
            risk_level=t.risk_level,
            abstraction_level=t.abstraction_level,
            parallel_write_domains=list(t.parallel_write_domains),
        )
        tasks.append(plan_task)
        statuses.append(
            TaskStatusOverride(
                id=t.id,
                status=t.status,
                block_reason=t.block_reason,
            )
        )

    total = len(tasks)
    complete = sum(1 for s in statuses if s.status == "COMPLETE")
    completion_pct = round(100.0 * complete / total, 1) if total else 0.0

    meta = dict(base_template.metadata)
    replanned_ids = [t.id for t in task_graph.tasks if t.id not in template_ids]
    if replanned_ids:
        meta["replanned_task_ids"] = replanned_ids

    return PlanSnapshot(
        name=base_template.name,
        version=base_template.version,
        success_criteria=base_template.success_criteria,
        tags=list(base_template.tags),
        tasks=tasks,
        metadata=meta,
        run_id=run_id,
        turn=turn,
        exported_at=datetime.now(UTC).isoformat(),
        completion_pct=completion_pct,
        task_statuses=statuses,
    )
