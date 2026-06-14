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
) -> Any:
    """Re-resolve control_state if stale and diagnostics are available.

    Returns a fresh control_state. Raises StalenessError if still stale
    after resolution, or if diagnostics were not provided.
    """
    from .control_state import resolve_control_state

    if not staleness_check(control_state, world_model):
        return control_state

    if diagnostics is None:
        raise StalenessError(
            f"control_state.generation_id={control_state.generation_id} is behind "
            f"world_model.generation_id={world_model.generation_id}. "
            "Provide diagnostics to allow automatic re-resolution."
        )

    fresh = resolve_control_state(
        diagnostics,
        world_model,
        failure_diagnostics,
        step=world_model.generation_id,
    )

    if staleness_check(fresh, world_model):
        raise StalenessError(
            "control_state is still stale after one re-resolution — "
            f"generation_id={fresh.generation_id} vs world_model={world_model.generation_id}"
        )
    return fresh


def decomposition_gate(
    task_graph: Any,
    *,
    control_state: Any,
    world_model: Any,
    diagnostics: Any | None = None,
    failure_diagnostics: Any | None = None,
) -> bool:
    """Gate task decomposition.

    Returns False when control_state is BLOCKED (decomposition not allowed).
    Returns True when NORMAL or CAUTIOUS.
    Re-resolves control_state once if stale.
    """
    control_state = _maybe_resolve(control_state, world_model, diagnostics, failure_diagnostics)

    if control_state.risk_state == "BLOCKED":
        return False

    if control_state.risk_state == "CAUTIOUS":
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
) -> Literal["PASS", "BLOCK", "ESCALATE"]:
    """Gate action execution (sub-step A freshness check).

    Returns:
      'ESCALATE' when escalation_reason is HUMAN_REQUIRED (before evaluating block_mask).
      'BLOCK' when control_state is BLOCKED or action overlaps a blocked dimension.
      'PASS' otherwise.

    Re-resolves control_state once if stale.
    """
    control_state = _maybe_resolve(control_state, world_model, diagnostics, failure_diagnostics)

    if getattr(control_state, "escalation_reason", None) == "HUMAN_REQUIRED":
        return "ESCALATE"

    if control_state.risk_state == "BLOCKED":
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
) -> bool:
    """Gate post-execution commit (sub-step B freshness check).

    Returns False when:
    - control_state is stale and cannot be re-resolved, or
    - contract_shadow_check fails (when output_contract is provided), or
    - verification_result.has_critical_failure is True.

    Re-resolves control_state once if stale.
    """
    control_state = _maybe_resolve(control_state, world_model, diagnostics, failure_diagnostics)

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
