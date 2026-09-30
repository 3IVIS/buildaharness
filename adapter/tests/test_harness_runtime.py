"""HarnessRuntime (adapter/harness/runtime.py) — the synchronous twin of TS driveMainLoop."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from harness.escalation import EscalationHalt
from harness.external_updates import PendingUpdate, UpdateChannel
from harness.investigation import INVESTIGATION_DONE_PREFIX, InvestigationFinding, resolve_gather_evidence
from harness.runtime import (
    HarnessRunOptions,
    HarnessRuntime,
    SelfReferentialDependencyError,
    initialize_harness_state,
    validate_recovery_action_dependencies,
)
from harness.supervisor import SupervisorDirective, resolve_supervisor_directive
from harness.task_graph import Task
from harness.world_model import WorldModel

SUCCESS_ORDER = [
    "context_compression",
    "check_caller_updates",
    "detect_contradictions",
    "generate_update_hypotheses",
    "update_diagnostics",
    "resolve_control_state",
    "update_task_graph",
    "select_task",
    "estimate_risk",
    "estimate_voi",
    "review_proposed_change",
    "action_gate",
    "execute",
    "gather_evidence",
    "apply_tool_reliability",
    "update_world_model_post_exec",
    "update_diagnostics_post_exec",
    "resolve_control_state_b",
    "verify",
    "post_exec_gate",
    "update_task_state",
]


def test_init_builds_a_task_per_criterion_and_resolves_control_state() -> None:
    init = initialize_harness_state("obj", success_criteria=["a", "b"])
    assert init.valid and init.decomposition_gate
    assert [t.id for t in init.task_graph.tasks] == ["task-0", "task-1"]
    assert init.world_model.generation_id == 1
    for src in ("execution_engine", "result_inspection", "fact_extraction", "world_model_trail"):
        assert init.evidence_store.is_tool_available(src)


def test_init_reports_dangling_dependency() -> None:
    init = initialize_harness_state("obj", initial_tasks=[Task(id="t", description="d", depends_on=["missing"])])
    assert not init.valid and "unknown task" in init.errors[0]


def test_self_referential_recovery_dependency_is_rejected() -> None:
    with pytest.raises(SelfReferentialDependencyError):
        validate_recovery_action_dependencies({"x": {"x"}})


def test_single_task_run_follows_the_ts_node_order() -> None:
    result = HarnessRuntime().run("do it", ["one"], HarnessRunOptions(skip_reviewer_pass=True))
    assert result.node_execution_order[: len(SUCCESS_ORDER)] == SUCCESS_ORDER
    assert result.node_execution_order[-1] == "output_validation"
    assert result.context.task_graph.tasks[0].status == "COMPLETE"
    assert result.final_result == {"completed": True}
    assert result.context.strategy_state.completion_history == [1]
    assert len(result.context.strategy_state.risk_state_history) == 1
    # generation_id advances by exactly two per executed iteration after init (INV-03) plus the evidence bumps
    assert result.context.world_model.generation_id > 2


def test_reviewer_pass_runs_unless_skipped() -> None:
    result = HarnessRuntime().run("do it", ["one"])
    assert "reviewer_pass" in result.node_execution_order


def test_failing_task_goes_through_rollback_replan() -> None:
    def boom() -> dict[str, bool]:
        raise RuntimeError("boom")

    opts = HarnessRunOptions(tool_executors={"default": boom}, skip_reviewer_pass=True)
    result = HarnessRuntime().run("do it", ["one"], opts)
    assert "rollback_replan" in result.node_execution_order
    # a FAILED leaf is not re-queued by a LOCAL replan: select_task finds nothing and the turn ends with the fallback
    assert result.context.task_graph.tasks[0].status == "FAILED"
    assert result.context.failure_diagnostics.failure_history
    assert isinstance(result.final_result, str) and result.final_result.startswith("I couldn't complete this")


def test_continuable_execution_reruns_the_task_without_sub_step_a() -> None:
    calls = {"n": 0}

    def step() -> dict[str, object]:
        calls["n"] += 1
        if calls["n"] < 3:
            return {"__harnessExecutionStatus": "continue"}
        return {"completed": True}

    opts = HarnessRunOptions(tool_executors={"default": step}, skip_reviewer_pass=True)
    result = HarnessRuntime().run("do it", ["one"], opts)
    order = result.node_execution_order
    assert calls["n"] == 3 and order.count("action_gate_replay_continuation") == 2
    assert order.count("select_task") == 1 and order.count("execute") == 3
    assert result.context.task_graph.tasks[0].status == "COMPLETE"


def test_budget_exhaustion_raises_escalation_halt() -> None:
    def forever() -> dict[str, object]:
        return {"__harnessExecutionStatus": "continue"}

    opts = HarnessRunOptions(max_steps=2, tool_executors={"default": forever}, skip_reviewer_pass=True)
    with pytest.raises(EscalationHalt) as exc:
        HarnessRuntime().run("do it", ["one"], opts)
    assert exc.value.blocker.reason == "budget_exhausted"


def test_budget_backstop_does_not_fire_when_all_tasks_complete() -> None:
    result = HarnessRuntime().run("do it", ["one"], HarnessRunOptions(max_steps=1, skip_reviewer_pass=True))
    assert result.context.task_graph.tasks[0].status == "COMPLETE"


def test_semantic_task_completion_rejection_fails_the_task() -> None:
    seen: list[dict[str, object]] = []

    def verdict(arg: dict[str, object]) -> dict[str, object]:
        seen.append(arg)
        return {"done": False, "reason": "nope"}

    opts = HarnessRunOptions(semantic_task_completion=verdict, skip_reviewer_pass=True)
    result = HarnessRuntime().run("do it", ["one"], opts)
    assert seen and seen[0]["task_description"] == "one"
    assert result.context.task_graph.tasks[0].status == "FAILED"
    assert str(result.final_result).startswith("I didn't complete this step — ")
    assert any(o.content.startswith("TASK_NOT_ACCOMPLISHED") for o in result.context.world_model.observations)


class _OneShotChannel(UpdateChannel):
    def __init__(self, payload: dict[str, object]) -> None:
        self._payload: dict[str, object] | None = payload

    def poll(self) -> PendingUpdate | None:
        if self._payload is None:
            return None
        payload, self._payload = self._payload, None
        return PendingUpdate(update_type="constraint", payload=payload, received_at=datetime.now(UTC))


def test_caller_update_restarts_the_iteration() -> None:
    chan = _OneShotChannel({"new_constraints": ["be brief"]})
    result = HarnessRuntime().run("do it", ["one"], HarnessRunOptions(update_channel=chan, skip_reviewer_pass=True))
    order = result.node_execution_order
    assert order[:2] == ["context_compression", "check_caller_updates"]
    assert order[2:4] == ["context_compression", "check_caller_updates"]  # restarted before Sub-step A


def test_supervisor_resolution_fails_open_and_coerces() -> None:
    def boom(_digest: dict[str, object]) -> dict[str, object]:
        raise RuntimeError("x")

    assert resolve_supervisor_directive(boom, {}).action == "CONTINUE"
    seen: list[str] = []
    d = resolve_supervisor_directive(
        lambda _d: {"action": "REFRAME_PLAN", "plan_note": "rethink", "rationale": "r"},
        {},
        lambda directive: seen.append(directive.action),
    )
    assert d.action == "REFRAME_PLAN" and seen == ["REFRAME_PLAN"]


def test_resolve_gather_evidence_paths() -> None:
    wm = WorldModel()
    directive = SupervisorDirective.from_dict(
        {
            "action": "GATHER_EVIDENCE",
            "rationale": "look",
            "investigation": {"question": "why?", "suggested_tools": ["search"]},
        }
    )
    assert "[not wired: GATHER_EVIDENCE]" in resolve_gather_evidence(wm, directive, None).rationale
    done = resolve_gather_evidence(wm, directive, lambda _req: [InvestigationFinding(content="c", tool="search")])
    assert done.action == "CONTINUE" and done.rationale.startswith(INVESTIGATION_DONE_PREFIX)
    assert any(o.source == "supervisor_investigation" for o in wm.observations)

    def broken(_req: dict[str, object]) -> list[InvestigationFinding]:
        raise RuntimeError("x")

    assert "[investigation failed]" in resolve_gather_evidence(WorldModel(), directive, broken).rationale


# ── Python-only features bridged into the runtime ────────────────────────────


def test_on_node_hook_sees_every_node_and_cannot_break_the_run() -> None:
    seen: list[str] = []

    def hook(name: str, _ctx: object) -> None:
        seen.append(name)
        raise RuntimeError("tracing down")

    result = HarnessRuntime().run("do it", ["one"], HarnessRunOptions(on_node=hook, skip_reviewer_pass=True))
    assert seen == result.node_execution_order


def test_exhausted_recovery_budget_halts_a_stalled_run(monkeypatch: pytest.MonkeyPatch) -> None:
    import harness.progress as progress

    monkeypatch.setattr(progress, "cannot_make_progress", lambda *_a, **_k: True)
    from harness.recovery import RecoveryBudget

    def boom() -> dict[str, bool]:
        raise RuntimeError("boom")

    tasks = [Task(id=f"t{i}", description=f"step {i}") for i in range(6)]
    exhausted = RecoveryBudget(max_plan_revisions=0)
    opts = HarnessRunOptions(
        initial_tasks=tasks, tool_executors={"default": boom}, recovery_budget=exhausted, skip_reviewer_pass=True
    )
    with pytest.raises(EscalationHalt) as exc:
        HarnessRuntime().run("do it", [], opts)
    assert exc.value.blocker.missing_info == ["recovery_budget"]


def test_plan_export_runs_each_iteration_and_never_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    import harness.plan_store as plan_store

    calls: list[int] = []

    def fake_save(**kw: object) -> None:
        calls.append(int(kw["turn"]))  # type: ignore[call-overload]
        raise OSError("disk full")

    monkeypatch.setattr(plan_store, "save_plan", fake_save)
    result = HarnessRuntime().run(
        "do it", ["a", "b"], HarnessRunOptions(plan_template=object(), skip_reviewer_pass=True)
    )
    assert calls and calls[0] == 1 and result.context.task_graph.tasks[1].status == "COMPLETE"


def test_db_shaped_experience_store_is_warm_started_and_captures_completions(monkeypatch: pytest.MonkeyPatch) -> None:
    import harness.experience_store as es

    class DbStore:  # no get_strategy_weights: the DB-backed API shape
        available = True

    warm: list[object] = []
    captured: list[str] = []
    monkeypatch.setattr(es, "warm_start", lambda store, *a: warm.append(a[-2]))
    monkeypatch.setattr(es, "update_experience_store", lambda **kw: captured.append(kw["completed_task"].id))
    opts = HarnessRunOptions(experience_store=DbStore(), task_class="docs", skip_reviewer_pass=True)
    HarnessRuntime().run("do it", ["a"], opts)
    assert warm == ["docs"] and captured == ["task-0"]


def test_adapter_run_state_is_seeded_like_ts_initialize() -> None:
    from harness.runtime import build_harness_run_state

    state = build_harness_run_state("r1")
    assert state.run_id == "r1"
    assert state.failure_diagnostics.failure_mode_library.get_entries()  # default library, as TS seeds it
    assert state.evidence_store.is_tool_available("execution_engine")
    assert state.memory_state.journal_retention_policy.max_passing_verbatim == 20
