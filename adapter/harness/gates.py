"""
Gate implementations — P3.5.

Full implementations replacing the P0.3 NotImplementedError stubs.
Each gate performs a staleness check, re-resolves control_state once if stale,
then applies its phase-specific logic.

StalenessError is re-exported from this module for backward compatibility.
assert_generation_fresh is still importable and works as a general-purpose
decorator — it is no longer applied to the gate functions themselves since
gates handle staleness internally.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Literal

from .staleness import StalenessError, assert_generation_fresh, staleness_check

__all__ = [
    "StalenessError",
    "action_gate",
    "assert_generation_fresh",
    "decomposition_gate",
    "post_exec_gate",
]


def _maybe_resolve(
    control_state: Any,
    world_model: Any,
    diagnostics: Any | None,
    failure_diagnostics: Any | None,
    resolver: Callable[[Any, Any, Any], Any] | None = None,
) -> Any:
    """Re-resolve a stale control_state IN PLACE (TS _maybeResolve): the caller's object is updated, not replaced.

    Raises StalenessError when it is stale and no diagnostics were provided, or when it is still stale after one
    resolution. `resolver(diagnostics, world_model, failure_diagnostics)` defaults to resolve_control_state (TS
    callers always pass `resolveControlState`).
    """
    from .control_state import resolve_control_state
    from .failure_modes import FailureDiagnostics

    if not staleness_check(control_state, world_model):
        return control_state

    if diagnostics is None:
        raise StalenessError(
            f"ControlState generation_id ({control_state.generation_id}) is stale relative to "
            f"WorldModel ({world_model.generation_id})"
        )

    fd = failure_diagnostics if failure_diagnostics is not None else FailureDiagnostics()
    resolved = (
        resolver(diagnostics, world_model, fd)
        if resolver is not None
        else resolve_control_state(diagnostics, world_model, fd, step=world_model.generation_id)
    )

    control_state.generation_id = resolved.generation_id
    control_state.permission = resolved.permission
    control_state.execution_mode = resolved.execution_mode
    control_state.escalation = resolved.escalation
    control_state.risk_estimate = resolved.risk_estimate
    control_state.confidence_estimate = resolved.confidence_estimate
    control_state.escalation_reason = resolved.escalation_reason
    control_state.block_mask = list(resolved.block_mask)
    control_state.notes = list(resolved.notes)

    if staleness_check(control_state, world_model):
        raise StalenessError(
            "ControlState still stale after one resolution attempt "
            f"(generation_id={control_state.generation_id}, worldModel.generation_id={world_model.generation_id})"
        )
    return control_state


def decomposition_gate(
    task_graph: Any,
    *,
    control_state: Any,
    world_model: Any,
    diagnostics: Any | None = None,
    failure_diagnostics: Any | None = None,
    resolver: Callable[[Any, Any, Any], Any] | None = None,
) -> bool:
    """Gate task decomposition.

    Returns False when control_state is BLOCKED (decomposition not allowed).
    Returns True when NORMAL or CAUTIOUS.
    Re-resolves control_state once if stale.
    """
    control_state = _maybe_resolve(control_state, world_model, diagnostics, failure_diagnostics, resolver)

    if control_state.permission == "DENY":
        return False

    if control_state.execution_mode == "CAUTIOUS":
        # Allow decomposition with advisory note (logged via return value context)
        return True

    return True


def action_gate(
    action: Any,
    *,
    control_state: Any,
    world_model: Any,
    diagnostics: Any | None = None,
    failure_diagnostics: Any | None = None,
    resolver: Callable[[Any, Any, Any], Any] | None = None,
) -> Literal["PASS", "BLOCK", "ESCALATE"]:
    """Gate action execution (sub-step A freshness check).

    Returns:
      'ESCALATE' when escalation_reason is HUMAN_REQUIRED (before evaluating block_mask).
      'BLOCK' when control_state is BLOCKED or action overlaps a blocked dimension.
      'PASS' otherwise.

    Re-resolves control_state once if stale.
    """
    control_state = _maybe_resolve(control_state, world_model, diagnostics, failure_diagnostics, resolver)

    if getattr(control_state, "escalation_reason", None) == "HUMAN_REQUIRED":
        return "ESCALATE"

    if control_state.permission == "DENY":
        return "BLOCK"

    blocked_dims = {entry.dimension for entry in control_state.block_mask}
    if blocked_dims and action is not None:
        required = _get_required_resources(action)
        if required & blocked_dims:
            return "BLOCK"

    return "PASS"


def post_exec_gate(
    result: Any,
    verification_result: Any,
    *,
    control_state: Any,
    world_model: Any,
    diagnostics: Any | None = None,
    output_contract: Any | None = None,
    failure_diagnostics: Any | None = None,
    resolver: Callable[[Any, Any, Any], Any] | None = None,
) -> bool:
    """Gate post-execution commit (sub-step B freshness check).

    Returns False when:
    - control_state is stale and cannot be re-resolved, or
    - contract_shadow_check fails (when output_contract is provided), or
    - verification_result.has_critical_failure is True.

    Re-resolves control_state once if stale.
    """
    control_state = _maybe_resolve(control_state, world_model, diagnostics, failure_diagnostics, resolver)

    if output_contract is not None:
        from .output_contract import contract_shadow_check

        check = contract_shadow_check(result, output_contract)
        if not check.passed:
            return False

    if _has_critical_failure(verification_result):
        return False

    return True


def _get_required_resources(action: Any) -> set[str]:
    """Extract required resource dimensions from an action descriptor."""
    if isinstance(action, dict):
        resources = action.get("required_resources", [])
        if isinstance(resources, (list, set)):
            return set(resources)
    required = getattr(action, "required_resources", None)
    if required is not None:
        return set(required)
    return set()


def _has_critical_failure(verification_result: Any) -> bool:
    """Check whether verification_result indicates a critical failure."""
    if isinstance(verification_result, dict):
        return bool(verification_result.get("has_critical_failure", False))
    return bool(getattr(verification_result, "has_critical_failure", False))
