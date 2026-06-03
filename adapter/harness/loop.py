"""
Main loop skeleton stub — P3.5.

Two-substep double-increment model (INV-03):
  Sub-step A: increment_generation_id → resolve control_state → action_gate
  Sub-step B: execute action → increment_generation_id → post_exec_gate

Full execution logic (action execution, verification) is populated in P5.
select_best_action() reads control_state exclusively for control decisions (INV-06).
"""

from __future__ import annotations

from typing import Any

from .control_state import ControlState, resolve_control_state
from .diagnostics import Diagnostics
from .gates import action_gate, post_exec_gate
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
    # P5 will populate real action selection logic here
    return {"type": "noop", "exploration": True}


def run_one_iteration(
    world_model: Any,
    diagnostics: Diagnostics,
    hypothesis_set: Any,
    task_graph: Any,
    failure_diagnostics: Any | None = None,
) -> dict[str, Any]:
    """Run one full loop iteration — increments generation_id exactly twice (INV-03).

    Sub-step A: pre-execution increment → resolve → action_gate
    Sub-step B: post-execution increment → resolve → post_exec_gate
    """
    # Sub-step A
    increment_generation_id(world_model)
    control_state = resolve_control_state(
        diagnostics,
        world_model,
        failure_diagnostics,
        step=world_model.generation_id,
    )

    action = select_best_action(control_state, world_model, hypothesis_set, task_graph)

    gate_a_result = action_gate(
        action,
        control_state=control_state,
        world_model=world_model,
        diagnostics=diagnostics,
        failure_diagnostics=failure_diagnostics,
    )

    # Sub-step B (action execution goes here in P5)
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

    return {
        "control_state_a": control_state,
        "control_state_b": control_state_b,
        "gate_a": gate_a_result,
        "gate_b": gate_b_result,
        "action": action,
    }
