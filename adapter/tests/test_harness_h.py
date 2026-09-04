"""
Phase H — Planning-layer primitive separation (ADR-003 F-2).

Covers: TaskOutcome / apply_task_outcome() as the single State-write path,
select_best_action's move to policy.py, and INV-17 (no update_task_status()
call outside that one path).

Run: pytest adapter/tests/test_harness_h.py -v
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.control_state import ControlState
from harness.execution import execute
from harness.policy import select_best_action
from harness.task_graph import Task, TaskGraph, TaskOutcome, apply_task_outcome

HARNESS_DIR = Path(__file__).parent.parent / "harness"

# Files allowed to call TaskGraph.update_task_status() directly — the primitive's own
# module (defines it) and apply_task_outcome() (the one wrapper). Everything else in
# production code must go through apply_task_outcome() (INV-17).
_ALLOWED_DIRECT_CALLERS = {"task_graph.py"}


def test_inv17_no_direct_update_task_status_outside_task_graph() -> None:
    """INV-17: no production module other than task_graph.py itself calls
    TaskGraph.update_task_status() directly — execution.py, loop.py, and any future
    caller must go through apply_task_outcome()."""
    offenders: list[str] = []
    for path in HARNESS_DIR.glob("*.py"):
        if path.name in _ALLOWED_DIRECT_CALLERS:
            continue
        text = path.read_text()
        if re.search(r"\.update_task_status\(", text):
            offenders.append(path.name)
    assert offenders == [], f"direct update_task_status() call(s) outside apply_task_outcome(): {offenders}"


def test_apply_task_outcome_transitions_status() -> None:
    tg = TaskGraph(tasks=[Task(id="a", description="d", status="PENDING")])
    apply_task_outcome(tg, "a", TaskOutcome(status="ACTIVE"))
    assert tg.get_task("a").status == "ACTIVE"
    apply_task_outcome(tg, "a", TaskOutcome(status="VERIFYING"))
    assert tg.get_task("a").status == "VERIFYING"


def test_apply_task_outcome_invalid_transition_raises() -> None:
    tg = TaskGraph(tasks=[Task(id="a", description="d", status="PENDING")])
    with pytest.raises(ValueError):
        apply_task_outcome(tg, "a", TaskOutcome(status="COMPLETE"))


def test_apply_task_outcome_stamps_completed_evidence_on_complete() -> None:
    tg = TaskGraph(tasks=[Task(id="a", description="d", status="VERIFYING")])
    apply_task_outcome(tg, "a", TaskOutcome(status="COMPLETE", evidence_ids=["belief-1", "belief-2"]))
    task = tg.get_task("a")
    assert task.status == "COMPLETE"
    assert task.completed_evidence == ["belief-1", "belief-2"]


def test_apply_task_outcome_does_not_stamp_evidence_on_non_complete() -> None:
    tg = TaskGraph(tasks=[Task(id="a", description="d", status="PENDING")])
    apply_task_outcome(tg, "a", TaskOutcome(status="ACTIVE", evidence_ids=["belief-1"]))
    assert tg.get_task("a").completed_evidence == []


def test_apply_task_outcome_block_reason_propagates() -> None:
    tg = TaskGraph(tasks=[Task(id="a", description="d", status="PENDING")])
    apply_task_outcome(tg, "a", TaskOutcome(status="BLOCKED", block_reason="waiting on human"))
    task = tg.get_task("a")
    assert task.status == "BLOCKED"
    assert task.block_reason == "waiting on human"


def test_task_outcome_continue_field_defaults_false_and_unconsumed() -> None:
    """Forward-compat field for Phase D1's loop-again signal — additive, unused today."""
    outcome = TaskOutcome(status="ACTIVE")
    assert outcome.continue_ is False


# ── Characterization: select_best_action's decisions are unchanged by the move ──


def test_select_best_action_deny_returns_none() -> None:
    cs = ControlState(permission="DENY")
    assert select_best_action(cs, None, None, None) is None


def test_select_best_action_allow_returns_noop_exploration() -> None:
    cs = ControlState(permission="ALLOW")
    result = select_best_action(cs, None, None, None)
    assert result == {"type": "noop", "exploration": True}


# ── Characterization: execute() still drives the ACTIVE/FAILED/VERIFYING lifecycle
#    identically now that it goes through apply_task_outcome() instead of calling
#    TaskGraph.update_task_status() directly ──


def test_execute_success_lifecycle_via_apply_task_outcome() -> None:
    task = Task(id="t1", description="do it", status="PENDING")
    tg = TaskGraph(tasks=[task])
    result = execute(
        proposed_change={"change_type": "read-only"},
        tool_workflow=lambda: "ok",
        world_model=None,
        task_graph=tg,
        current_task=task,
        evidence_store=None,
    )
    assert result.success is True
    assert tg.get_task("t1").status == "VERIFYING"


def test_execute_failure_lifecycle_via_apply_task_outcome() -> None:
    task = Task(id="t1", description="do it", status="PENDING")
    tg = TaskGraph(tasks=[task])

    def _boom() -> None:
        raise RuntimeError("nope")

    result = execute(
        proposed_change={"change_type": "read-only"},
        tool_workflow=_boom,
        world_model=None,
        task_graph=tg,
        current_task=task,
        evidence_store=None,
    )
    assert result.success is False
    assert tg.get_task("t1").status == "FAILED"
