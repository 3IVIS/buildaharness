"""
Main loop — P3.5 skeleton extended with P6 recovery & memory wiring, P7
external update poll + escalation triggers, and P8 experience store hooks.

Two-substep double-increment model (INV-03):
  Sub-step A: increment_generation_id → resolve control_state → action_gate
  Sub-step B: execute action → increment_generation_id → post_exec_gate

P6 additions (wired per-iteration):
  - should_compress / compress_memory (P6.5)
  - check_max_steps with warn/escalate routing (P6.6)
  - cannot_make_progress + switch_strategy (P6.1/P6.2)
  - apply_replan on stall or global contradiction (P6.4)
  - apply_retention_policy on journal at end of each step (P6.6)

P7 additions (wired per-iteration):
  - check_external_updates at very top of each iteration (P7.1)
  - escalate() when risk_state == BLOCKED (P7.3)
  - escalate() when strategy == ESCALATE (P7.3)

P8 additions:
  - warm_start() called once on step_count == 0 (P8.2)
  - update_experience_store() hook when a completed_task is passed (P8.3)
"""

from __future__ import annotations

from typing import Any

from .control_state import ControlState, resolve_control_state
from .diagnostics import Diagnostics
from .external_updates import NoOpUpdateChannel, UpdateChannel, check_external_updates
from .gates import action_gate, post_exec_gate
from .memory import MemoryState, apply_retention_policy, check_max_steps, compress_memory, should_compress
from .progress import cannot_make_progress
from .recovery import StrategyState, switch_strategy
from .replanning import ReplanScope, apply_replan, assess_replan_scope
from .staleness import increment_generation_id


def select_best_action(
    control_state: ControlState,
    world_model: Any,
    hypothesis_set: Any,
    task_graph: Any,
) -> Any:
    """Stub: select action based solely on control_state (INV-06).

    world_model, hypothesis_set, and task_graph are read-only informational
    context. They must not directly suppress or permit actions — only
    control_state drives that decision.
    """
    if control_state.risk_state == "BLOCKED":
        return None
    return {"type": "noop", "exploration": True}


def _build_surface_blocker(reason: str, control_state: ControlState, task_graph: Any) -> Any:
    """Build a SurfaceBlocker from current control_state context."""
    from .escalation import SurfaceBlocker

    missing_info: list[str] = []

    # Derive missing_info from block_mask entries
    if hasattr(control_state, "block_mask"):
        for entry in control_state.block_mask:
            if hasattr(entry, "recovery_action"):
                missing_info.append(entry.recovery_action)
    if not missing_info and reason == "cannot_make_progress":
        missing_info = ["clarification on how to proceed", "revised success criteria"]
    if not missing_info and reason == "budget_exhausted":
        missing_info = ["increased step budget", "revised scope"]
    if not missing_info:
        missing_info = ["human clarification required"]

    # Brief current task summary
    current_task_summary = "No active task"
    if task_graph is not None and hasattr(task_graph, "tasks"):
        for t in task_graph.tasks:
            if getattr(t, "status", None) == "ACTIVE":
                current_task_summary = f"Task {t.id}: {t.description}"
                break
        if current_task_summary == "No active task":
            for t in task_graph.tasks:
                if getattr(t, "status", None) == "PENDING":
                    current_task_summary = f"Next pending: {t.id}: {t.description}"
                    break

    # escalation_reason from control_state if available
    escalation_reason = getattr(control_state, "escalation_reason", None)
    if escalation_reason:
        current_task_summary = f"{current_task_summary} | reason: {escalation_reason}"

    return SurfaceBlocker(
        reason=reason,
        missing_info=missing_info,
        current_task_summary=current_task_summary,
    )


def run_one_iteration(
    world_model: Any,
    diagnostics: Diagnostics,
    hypothesis_set: Any,
    task_graph: Any,
    failure_diagnostics: Any | None = None,
    memory_state: MemoryState | None = None,
    strategy_state: StrategyState | None = None,
    caller_state: Any | None = None,
    step_count: int = 0,
    update_channel: UpdateChannel | None = None,
    output_contract: Any | None = None,
    harness_run_state: Any | None = None,
    run_id: str = "",
    experience_store: Any | None = None,
    task_class: str = "",
    dep_graph_budget: Any | None = None,
    completed_task: Any | None = None,
    execution_context: Any | None = None,
    belief_dep_graph: Any | None = None,
    evidence_store: Any | None = None,
) -> dict[str, Any]:
    """Run one full loop iteration — increments generation_id exactly twice (INV-03).

    Sub-step A: pre-execution increment → resolve → action_gate
    Sub-step B: post-execution increment → resolve → post_exec_gate

    P6 hooks fire at the top of Sub-step A (compression, budget check, stall
    detection) and at the end of Sub-step B (journal retention).

    P7 hook: check_external_updates fires before all P6 hooks. Escalation
    triggers fire after resolve_control_state() in Sub-step A when
    risk_state==BLOCKED, and after stall detection when strategy==ESCALATE.
    """
    from .escalation import EscalationHalt, escalate

    escalation: dict[str, Any] | None = None
    channel = update_channel if update_channel is not None else NoOpUpdateChannel()

    # ── P8 — warm_start on first iteration ───────────────────────────────────
    if step_count == 0 and experience_store is not None:
        from .experience_store import warm_start

        warm_start(
            experience_store=experience_store,
            strategy_state=strategy_state,
            failure_diagnostics=failure_diagnostics,
            task_graph=task_graph,
            task_class=task_class or None,
            dep_graph_budget=dep_graph_budget,
        )

    # ── P8 — update_experience_store hook on task completion ─────────────────
    if completed_task is not None and experience_store is not None:
        from .experience_store import update_experience_store

        update_experience_store(
            completed_task=completed_task,
            strategy_state=strategy_state,
            execution_context=execution_context,
            experience_store=experience_store,
        )

    # ── P7.1 — external updates poll (must be first, before any state mutation) ─
    if caller_state is not None:
        check_external_updates(
            channel,
            caller_state,
            world_model,
            task_graph,
            diagnostics,
            output_contract=output_contract,
        )
        # If an update was applied, control_state will be re-resolved in Sub-step A
        # (generation_id was already incremented by check_external_updates)

    # ── P6 pre-iteration hooks ────────────────────────────────────────────────

    if memory_state is not None:
        # P6.5 — compression trigger
        if should_compress(world_model, memory_state):
            compress_memory(world_model, memory_state)
            increment_generation_id(world_model)
            memory_state.journal.append({"event": "compression", "step": step_count, "outcome": "pass"})

        # P6.6 — budget check
        budget_status = check_max_steps(step_count, memory_state, diagnostics)
        if budget_status == "escalate":
            # P7.3 — replace stub escalation with structured surface_blocker
            if harness_run_state is not None:
                ctrl_stub = ControlState()
                blocker = _build_surface_blocker("budget_exhausted", ctrl_stub, task_graph)
                try:
                    escalate(blocker, harness_run_state, run_id)
                except EscalationHalt as exc:
                    return {
                        "escalated": True,
                        "escalation": exc.blocker.to_dict(),
                        "step_count": step_count,
                    }
            return {
                "escalated": True,
                "escalation": {
                    "reason": "budget_exhausted",
                    "missing_info": ["step_count", "max_steps"],
                },
                "step_count": step_count,
            }
        if budget_status == "warn":
            memory_state.journal.append({"event": "budget_warn", "step": step_count, "outcome": "pass"})

    # P6.1/P6.2 — stall detection and strategy switch
    if strategy_state is not None and failure_diagnostics is not None and task_graph is not None:
        if cannot_make_progress(strategy_state, failure_diagnostics, task_graph):
            reason = getattr(strategy_state, "stall_reason", "stall_detected")
            strategy_state = switch_strategy(strategy_state, reason)

            # P7.3 — escalate when strategy reaches ESCALATE
            if strategy_state.current_strategy == "ESCALATE":
                if harness_run_state is not None:
                    ctrl_stub = ControlState()
                    blocker = _build_surface_blocker("cannot_make_progress", ctrl_stub, task_graph)
                    try:
                        escalate(blocker, harness_run_state, run_id)
                    except EscalationHalt as exc:
                        return {
                            "escalated": True,
                            "escalation": exc.blocker.to_dict(),
                            "step_count": step_count,
                        }

            # P6.4 — replan on stall (treat as local scope with no specific contradiction)
            if caller_state is not None:
                contradiction = type("_C", (), {"scope": "local"})()
                current_task = None
                try:
                    from .task_graph import select_unblocked_leaf

                    current_task = select_unblocked_leaf(task_graph)
                except Exception:
                    pass
                if current_task is not None:
                    scope: ReplanScope = assess_replan_scope(contradiction, task_graph)
                    task_graph = apply_replan(scope, contradiction, current_task, task_graph, world_model, caller_state)
                    increment_generation_id(world_model)

    # ── Sub-step A ────────────────────────────────────────────────────────────
    increment_generation_id(world_model)
    control_state = resolve_control_state(
        diagnostics,
        world_model,
        failure_diagnostics,
        step=world_model.generation_id,
    )

    # P7.3 — escalate when risk_state is BLOCKED (INV-06: triggered by control_state)
    if control_state.risk_state == "BLOCKED":
        if harness_run_state is not None:
            blocker = _build_surface_blocker("blocked_state", control_state, task_graph)
            try:
                escalate(blocker, harness_run_state, run_id)
            except EscalationHalt as exc:
                return {
                    "escalated": True,
                    "escalation": exc.blocker.to_dict(),
                    "step_count": step_count,
                    "control_state_a": control_state,
                }

    action = select_best_action(control_state, world_model, hypothesis_set, task_graph)

    gate_a_result = action_gate(
        action,
        control_state=control_state,
        world_model=world_model,
        diagnostics=diagnostics,
        failure_diagnostics=failure_diagnostics,
    )

    # ── Sub-step B ────────────────────────────────────────────────────────────
    result: dict[str, Any] = {"action": action, "gate_a": gate_a_result}
    verification_result: dict[str, Any] = {"has_critical_failure": False}

    increment_generation_id(world_model)
    control_state_b = resolve_control_state(
        diagnostics,
        world_model,
        failure_diagnostics,
        step=world_model.generation_id,
    )

    gate_b_result = post_exec_gate(
        result,
        verification_result,
        control_state=control_state_b,
        world_model=world_model,
        diagnostics=diagnostics,
        failure_diagnostics=failure_diagnostics,
    )

    # P6.6 — journal retention at end of step
    if memory_state is not None:
        memory_state.journal = apply_retention_policy(memory_state.journal, memory_state.journal_retention_policy)

    # Track risk state history for oscillation proxy
    if strategy_state is not None:
        strategy_state.risk_state_history.append(control_state_b.risk_state)

    # ── P9 — reviewer pass after post_exec_gate ───────────────────────────────
    review_result: Any = None
    tasks_reopened = False

    if belief_dep_graph is not None and output_contract is not None:
        from .reviewer import reviewer_pass

        sc_list = getattr(caller_state, "success_criteria", []) if caller_state else []
        review_result = reviewer_pass(
            world_model=world_model,
            task_graph=task_graph,
            success_criteria=sc_list,
            output_contract=output_contract,
            hypothesis_set=hypothesis_set,
            evidence_store=evidence_store,
            caller_state=caller_state,
            belief_dep_graph=belief_dep_graph,
            failure_history=failure_diagnostics,
        )
        tasks_reopened = review_result.tasks_reopened

        # If no tasks were reopened, run the final output contract gate
        if not tasks_reopened and harness_run_state is not None:
            from .output_contract import completion_check_final

            result_payload = getattr(gate_b_result, "payload", None) or result
            try:
                completion_check_final(
                    result=result_payload,
                    output_contract=output_contract,
                    caller_state=caller_state,
                    harness_run_state=harness_run_state,
                )
            except EscalationHalt as exc:
                return {
                    "escalated": True,
                    "escalation": exc.blocker.to_dict(),
                    "step_count": step_count,
                    "review_result": review_result.to_dict() if review_result else None,
                }

    return {
        "control_state_a": control_state,
        "control_state_b": control_state_b,
        "gate_a": gate_a_result,
        "gate_b": gate_b_result,
        "action": action,
        "strategy_state": strategy_state,
        "task_graph": task_graph,
        "escalation": escalation,
        "review_result": review_result.to_dict() if review_result else None,
        "tasks_reopened": tasks_reopened,
    }
