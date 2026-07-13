"""Plan-first agent tools — fn_ref implementations callable from FlowSpecs.

Referenced in FlowSpecs as planner_tools.load_named_plan, etc.
All I/O is delegated to plan_store; this layer provides agent-facing wrappers.
"""

from __future__ import annotations

from pathlib import Path

from harness.plan_schema import PlanSnapshot  # type: ignore[import]
from harness.plan_store import (  # type: ignore[import]
    DEFAULT_SNAPSHOT_DIR,
    DEFAULT_TEMPLATE_DIR,
    list_plans,
    load_plan,
)


def load_named_plan(name: str) -> dict:
    """Load a plan template by name from the default template directory.

    Returns the plan as a dict for agent context injection.
    Raises PlanLoadError if the template is not found or invalid.
    """
    template = load_plan(name, DEFAULT_TEMPLATE_DIR)
    return template.model_dump()


def list_available_plans() -> list[str]:
    """Return sorted list of available plan template names."""
    return list_plans(DEFAULT_TEMPLATE_DIR)


def get_plan_status(run_id: str, snapshot_dir: Path = DEFAULT_SNAPSHOT_DIR) -> dict:
    """Load the latest snapshot for run_id and return status summary.

    Returns a dict with completion_pct and per-task statuses.
    Returns an empty dict if no snapshot exists for the run_id.
    """
    import json

    snapshots = sorted(snapshot_dir.glob(f"{run_id}_t*.json"))
    if not snapshots:
        return {}

    latest = snapshots[-1]
    try:
        raw = json.loads(latest.read_text(encoding="utf-8"))
        snapshot = PlanSnapshot.model_validate(raw)
    except Exception:
        return {}

    return {
        "run_id": snapshot.run_id,
        "turn": snapshot.turn,
        "completion_pct": snapshot.completion_pct,
        "task_statuses": [s.model_dump() for s in snapshot.task_statuses],
        "exported_at": snapshot.exported_at,
    }


def update_task_note(
    run_id: str,
    task_id: str,
    note: str,
    snapshot_dir: Path = DEFAULT_SNAPSHOT_DIR,
) -> bool:
    """Append an agent-generated note to a task in the latest snapshot.

    Writes a new snapshot file with the note appended to the task metadata.
    Returns True on success, False if the snapshot or task is not found.
    """
    import json
    import os

    snapshots = sorted(snapshot_dir.glob(f"{run_id}_t*.json"))
    if not snapshots:
        return False

    latest = snapshots[-1]
    try:
        raw = json.loads(latest.read_text(encoding="utf-8"))
        snapshot = PlanSnapshot.model_validate(raw)
    except Exception:
        return False

    # Find the task in the template tasks list
    found = False
    for task in snapshot.tasks:
        if task.id == task_id:
            notes = snapshot.metadata.setdefault("task_notes", {})
            if not isinstance(notes, dict):
                notes = {}
                snapshot.metadata["task_notes"] = notes
            existing = notes.get(task_id, [])
            if not isinstance(existing, list):
                existing = [existing]
            existing.append(note)
            notes[task_id] = existing
            found = True
            break

    if not found:
        return False

    try:
        payload = snapshot.model_dump_json(indent=2)
        # Write alongside existing snapshots with a _notes suffix turn indicator
        final = latest
        tmp = latest.with_suffix(".json.tmp")
        tmp.write_text(payload, encoding="utf-8")
        os.replace(tmp, final)
        return True
    except Exception:
        return False
