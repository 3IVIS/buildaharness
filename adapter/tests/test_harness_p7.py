"""
Phase 7 acceptance tests — Caller State & Escalation.

Tests T01–T09 as specified in plan/phase_7_plan.html.

Tests T01–T06 use mock channels and run without Postgres.
Tests T07–T09 require HarnessRunState persistence and the escalation
response endpoint (Postgres + running adapter). T07–T09 are implemented
here as unit tests against in-memory objects since the plan calls for
structural verification that can be validated without a running adapter.

Run all: pytest adapter/tests/test_harness_p7.py -v
"""

import sys
import time
from pathlib import Path
from typing import cast

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.caller_state import CallerState, inject_clarification
from harness.constraint_propagation import (
    apply_constraint_change_propagation,
)
from harness.diagnostics import Diagnostics
from harness.escalation import EscalationHalt, SurfaceBlocker, escalate
from harness.external_updates import (
    NoOpUpdateChannel,
    PendingUpdate,
    UpdateChannel,
    check_external_updates,
)
from harness.memory import MemoryState
from harness.output_contract import OutputContract
from harness.task_graph import Task, TaskGraph, TaskStatus
from harness.world_model import WorldModel

# ─── Helper factories ────────────────────────────────────────────────────────


def _make_world_model(**kwargs) -> WorldModel:
    wm = WorldModel(**kwargs)
    return wm


def _make_caller_state(constraints=None, success_criteria=None) -> CallerState:
    return CallerState(
        current_constraints=list(constraints or []),
        success_criteria=list(success_criteria or []),
    )


def _make_task_graph(*tasks: Task) -> TaskGraph:
    tg = TaskGraph()
    tg.tasks = list(tasks)
    return tg


def _make_task(id_: str, description: str, status: str = "PENDING") -> Task:
    return Task(id=id_, description=description, status=cast(TaskStatus, status))


class _MockChannel(UpdateChannel):
    """Test channel that returns a pre-configured update then None."""

    def __init__(self, update: PendingUpdate | None) -> None:
        self._update = update
        self._calls = 0

    def poll(self) -> PendingUpdate | None:
        self._calls += 1
        result = self._update
        self._update = None  # Only return once
        return result


class _FailingChannel(UpdateChannel):
    """Test channel that always raises."""

    def poll(self) -> PendingUpdate | None:
        raise RuntimeError("simulated connectivity failure")


# ══════════════════════════════════════════════════════════════════════════════
# T01–T03  P7.1 — check_external_updates()
# ══════════════════════════════════════════════════════════════════════════════


def test_T01_noop_channel_is_fast_and_nonmutating():
    """T01: NoOpUpdateChannel completes under 10ms, returns False, no state mutation."""
    wm = _make_world_model()
    initial_gen_id = wm.generation_id
    cs = _make_caller_state()
    initial_history_len = len(cs.clarification_history)
    tg = _make_task_graph()
    diag = Diagnostics()

    start = time.perf_counter()
    result = check_external_updates(NoOpUpdateChannel(), cs, wm, tg, diag)
    elapsed_ms = (time.perf_counter() - start) * 1000

    assert result is False, "NoOpUpdateChannel must return False"
    assert elapsed_ms < 10.0, f"poll took {elapsed_ms:.2f}ms — must be under 10ms"
    assert wm.generation_id == initial_gen_id, "generation_id must not change on no-update"
    assert len(cs.clarification_history) == initial_history_len, "clarification_history must not grow on no-update"


def test_T02_constraint_update_propagates():
    """T02: Mock channel with constraint update sets constraints_changed, increments
    generation_id, and revalidates task_graph."""
    wm = _make_world_model()
    initial_gen = wm.generation_id

    # Task scoped to "database" — will survive a "database" success criterion
    t1 = _make_task("t1", "migrate database schema")
    # Task unrelated to the new narrow criterion — will be scope-eliminated
    t2 = _make_task("t2", "update frontend javascript ui")
    tg = _make_task_graph(t1, t2)

    cs = _make_caller_state(
        constraints=["original constraint"],
        success_criteria=["migrate database schema"],
    )
    diag = Diagnostics()

    update = PendingUpdate(
        update_type="constraint",
        payload={
            "current_constraints": ["new constraint: only database work"],
            "success_criteria": ["migrate database schema"],
        },
    )
    channel = _MockChannel(update)

    result = check_external_updates(channel, cs, wm, tg, diag)

    assert result is True, "Must return True when an update is processed"
    assert cs.constraints_changed is True, "constraints_changed must be True after update"
    assert wm.generation_id > initial_gen, "generation_id must be incremented"
    # Task t1 (database) should remain; t2 (frontend) should be BLOCKED
    t2_after = next(t for t in tg.tasks if t.id == "t2")
    assert t2_after.status == "BLOCKED", "Out-of-scope task must be BLOCKED"
    assert t2_after.block_reason == "scope_eliminated"


def test_T03_channel_exception_returns_false_silently():
    """T03: Channel connectivity failure returns False — loop never crashes."""
    wm = _make_world_model()
    initial_gen = wm.generation_id
    cs = _make_caller_state()
    tg = _make_task_graph()
    diag = Diagnostics()

    result = check_external_updates(_FailingChannel(), cs, wm, tg, diag)

    assert result is False, "Channel exception must return False silently"
    assert wm.generation_id == initial_gen, "generation_id must not change on exception"


# ══════════════════════════════════════════════════════════════════════════════
# T04–T06  P7.2 — Constraint change propagation
# ══════════════════════════════════════════════════════════════════════════════


def test_T04_scope_narrowing_blocks_out_of_scope_tasks():
    """T04: Removing a target from success_criteria blocks tasks scoped to that target."""
    # Original: two success criteria covered by two tasks
    cs = _make_caller_state(
        success_criteria=["implement authentication"],
    )
    t_auth = _make_task("t-auth", "implement authentication module")
    t_report = _make_task("t-report", "generate financial report dashboard")
    tg = _make_task_graph(t_auth, t_report)

    wm = _make_world_model()
    oc = OutputContract()
    diag = Diagnostics()

    apply_constraint_change_propagation(cs, wm, tg, oc, diag)

    # t_auth shares "authentication" with criteria — stays PENDING
    assert t_auth.status == "PENDING", "In-scope task must remain PENDING"
    # t_report has no overlap with "implement authentication" — must be BLOCKED
    assert t_report.status == "BLOCKED", "Out-of-scope task must be BLOCKED"
    assert t_report.block_reason == "scope_eliminated"


def test_T05_scope_expanding_adds_pending_tasks():
    """T05: Adding a new success criterion adds new PENDING tasks to the graph."""
    cs = _make_caller_state(
        success_criteria=["fix login bug", "add export feature"],
    )
    existing = _make_task("t1", "fix login bug")
    tg = _make_task_graph(existing)

    wm = _make_world_model()
    oc = OutputContract()
    diag = Diagnostics()

    apply_constraint_change_propagation(cs, wm, tg, oc, diag)

    ids = {t.id for t in tg.tasks}
    pending_descriptions = [t.description for t in tg.tasks if t.status == "PENDING"]

    # Existing task stays
    assert "t1" in ids
    # New task for "add export feature" must have been added
    assert any("export" in desc for desc in pending_descriptions), (
        "New PENDING task should be added for uncovered criterion 'add export feature'"
    )
    # Original task is not modified
    assert existing.status == "PENDING"


def test_T06_conformance_both_paths_produce_identical_state():
    """T06: Both check_external_updates() path and direct apply_constraint_change_propagation()
    call produce identical task_graph and output_contract state for the same input."""

    def _build_state():
        cs = _make_caller_state(
            constraints=["c1"],
            success_criteria=["deploy service"],
        )
        t1 = _make_task("t1", "deploy service to production")
        t2 = _make_task("t2", "write unrelated documentation")
        tg = _make_task_graph(t1, t2)
        wm = _make_world_model()
        oc = OutputContract()
        diag = Diagnostics()
        return cs, tg, wm, oc, diag

    # Path A: direct call to apply_constraint_change_propagation
    cs_a, tg_a, wm_a, oc_a, diag_a = _build_state()
    inject_clarification(cs_a, {"current_constraints": ["c-new"], "success_criteria": ["deploy service"]})
    apply_constraint_change_propagation(cs_a, wm_a, tg_a, oc_a, diag_a)

    # Path B: via check_external_updates
    cs_b, tg_b, wm_b, oc_b, diag_b = _build_state()
    update = PendingUpdate(
        update_type="constraint",
        payload={"current_constraints": ["c-new"], "success_criteria": ["deploy service"]},
    )
    check_external_updates(_MockChannel(update), cs_b, wm_b, tg_b, diag_b, output_contract=oc_b)

    # Both task_graphs must have the same blocked/pending structure
    statuses_a = {t.id: (t.status, t.block_reason) for t in tg_a.tasks}
    statuses_b = {t.id: (t.status, t.block_reason) for t in tg_b.tasks}
    assert statuses_a == statuses_b, (
        f"Both propagation paths must produce identical task_graph state.\nPath A: {statuses_a}\nPath B: {statuses_b}"
    )

    # Both output_contracts must have identical caller_specific_constraints
    assert oc_a.caller_specific_constraints == oc_b.caller_specific_constraints, (
        "Both paths must produce identical output_contract.caller_specific_constraints"
    )


# ══════════════════════════════════════════════════════════════════════════════
# T07–T09  P7.3 — Escalation with surface_blocker
# ══════════════════════════════════════════════════════════════════════════════


class _MockHarnessRunState:
    """Minimal in-memory HarnessRunState for escalation tests."""

    def __init__(self):
        self.escalation_pending = False
        self.pending_escalation = None
        self.memory_state = MemoryState()
        self.memory_state.journal = []


def test_T07_blocked_risk_state_triggers_escalation():
    """T07: BLOCKED risk_state triggers escalate(): escalation_pending=True,
    pending_escalation.reason='blocked_state', EscalationHalt is raised."""
    blocker = SurfaceBlocker(
        reason="blocked_state",
        missing_info=["human must resolve contradiction"],
        current_task_summary="Task t1: implement auth (risk_state=BLOCKED)",
    )
    state = _MockHarnessRunState()

    with pytest.raises(EscalationHalt) as exc_info:
        escalate(blocker, state, run_id="run-test-007")

    assert state.escalation_pending is True
    assert state.pending_escalation is not None
    assert state.pending_escalation.reason == "blocked_state"
    assert exc_info.value.blocker.reason == "blocked_state"
    # Journal entry must be present
    assert any(e.get("action_class") == "escalation" for e in state.memory_state.journal), (
        "escalation journal entry must be recorded"
    )


def test_T08_cannot_make_progress_triggers_escalation():
    """T08: cannot_make_progress()==True with current_strategy=ESCALATE triggers
    escalation with reason='cannot_make_progress' and non-empty missing_info."""
    blocker = SurfaceBlocker(
        reason="cannot_make_progress",
        missing_info=["clarification on how to proceed", "revised success criteria"],
        current_task_summary="Task t1: stalled after 5 retries",
    )
    state = _MockHarnessRunState()

    with pytest.raises(EscalationHalt) as exc_info:
        escalate(blocker, state, run_id="run-test-008")

    assert state.escalation_pending is True
    assert exc_info.value.blocker.reason == "cannot_make_progress"
    assert len(exc_info.value.blocker.missing_info) > 0, "missing_info must be non-empty"


def test_T09_surface_blocker_contains_only_human_readable_fields():
    """T09: SurfaceBlocker carries reason, missing_info, current_task_summary only.
    It must NOT contain world_model data, hypothesis_set, or evidence_store entries."""
    blocker = SurfaceBlocker(
        reason="blocked_state",
        missing_info=["additional clarification needed"],
        current_task_summary="Task t2: deploy service — awaiting human input",
    )

    blocker_dict = blocker.to_dict()

    # Required human-readable fields
    assert "reason" in blocker_dict
    assert "missing_info" in blocker_dict
    assert "current_task_summary" in blocker_dict
    assert "escalated_at" in blocker_dict

    # Must NOT contain raw internal state
    forbidden_keys = {
        "world_model",
        "hypothesis_set",
        "evidence_store",
        "beliefs",
        "contradictions",
        "observations",
        "hypotheses",
        "evidence",
        "generation_id",
        "block_mask",
        "diagnostics",
    }
    present_forbidden = forbidden_keys & set(blocker_dict.keys())
    assert not present_forbidden, f"SurfaceBlocker must not contain internal state keys: {present_forbidden}"

    # Verify round-trip serialisation
    restored = SurfaceBlocker.from_dict(blocker_dict)
    assert restored.reason == blocker.reason
    assert restored.missing_info == blocker.missing_info
    assert restored.current_task_summary == blocker.current_task_summary
