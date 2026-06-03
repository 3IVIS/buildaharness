"""
Gate stubs — P0.3.

decomposition_gate, action_gate, and post_exec_gate are wired with
@assert_generation_fresh so staleness checking is exercised from Phase 0.
All three raise NotImplementedError — they exist to fail loudly, not to
silently pass. Full implementations are added in P3.
"""

from __future__ import annotations

from typing import Any

from .staleness import StalenessError, assert_generation_fresh  # noqa: F401 — re-exported


@assert_generation_fresh
def decomposition_gate(
    task_graph: Any,
    *,
    control_state: Any,
    world_model: Any,
) -> None:
    """Assert generation_id freshness then gate task decomposition.

    Full logic (PROCEED | GATHER_CLARIFICATION | ESCALATE) added in P3.
    """
    raise NotImplementedError("decomposition_gate not implemented until P3")


@assert_generation_fresh
def action_gate(
    action: Any,
    *,
    control_state: Any,
    world_model: Any,
) -> None:
    """Assert generation_id freshness (sub-step A value) then gate action selection.

    Full logic (BLOCK | ESCALATE | allow with exploration) added in P3.
    """
    raise NotImplementedError("action_gate not implemented until P3")


@assert_generation_fresh
def post_exec_gate(
    result: Any,
    verification: Any,
    *,
    control_state: Any,
    world_model: Any,
) -> None:
    """Assert generation_id freshness (sub-step B value) then gate post-execution.

    Full logic (COMMIT | ROLLBACK | FLAG_FOR_REVIEW | HALT) added in P3.
    """
    raise NotImplementedError("post_exec_gate not implemented until P3")
