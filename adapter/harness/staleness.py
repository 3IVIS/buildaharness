"""
generation_id staleness tracking infrastructure — P0.3 and P2.6.

Provides the increment helper, staleness predicate, and gate-assertion
decorator (P0.3). Also provides staleness_sweep() which invalidates beliefs
via TTL and environment_change_log (P2.6).

Gate implementations were stubs until P3; they are now fully implemented
in gates.py.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from functools import wraps
from typing import Any

from .world_model import WorldModel


class StalenessError(Exception):
    """Raised when control_state.generation_id lags world_model."""


@dataclass
class ControlStateStub:
    """Backward-compat placeholder kept for P0 tests.

    The real implementation is ControlState in control_state.py (P3).
    ControlStateStub has the same generation_id field so existing P0 tests
    that use it continue to pass without modification.
    """

    generation_id: int = 0
    extra: dict[str, Any] = field(default_factory=dict)


def increment_generation_id(world_model: WorldModel) -> None:
    """Advance world_model.generation_id by exactly 1.

    The two-substep wiring (sub-step A before execution, sub-step B after
    execution) is established in P3 when the main loop is built.
    """
    world_model.generation_id += 1


def staleness_check(control_state: ControlStateStub, world_model: WorldModel) -> bool:
    """Return True when control_state.generation_id is behind world_model.generation_id."""
    return control_state.generation_id < world_model.generation_id


def assert_generation_fresh[F: Callable[..., Any]](fn: F) -> F:
    """Decorator: raises StalenessError if the first control_state arg is stale.

    Gate functions decorated with this must accept (*, control_state, world_model, ...)
    as keyword arguments OR positional arguments where control_state is first and
    world_model is second after self/non-state positional args.

    Concretely, gate functions are expected to have the signature:
        gate_fn(*args, control_state, world_model, **kwargs)

    or pass them positionally with control_state at index -2 and world_model at -1.
    For simplicity, gates.py passes them as keyword arguments.
    """

    @wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        control_state = kwargs.get("control_state")
        world_model = kwargs.get("world_model")

        if control_state is None or world_model is None:
            # If not in kwargs, try positional convention (last two positional args)
            if len(args) >= 2:
                control_state = args[-2]
                world_model = args[-1]

        if control_state is not None and world_model is not None:
            if staleness_check(control_state, world_model):
                raise StalenessError(
                    f"control_state.generation_id={control_state.generation_id} is behind "
                    f"world_model.generation_id={world_model.generation_id}. "
                    "Re-invoke resolve_control_state() before calling this gate."
                )
        return fn(*args, **kwargs)

    return wrapper  # type: ignore[return-value]


# ── P2.6 staleness sweep ──────────────────────────────────────────────────────

_DEFAULT_BELIEF_TTL = timedelta(minutes=30)


def staleness_sweep(
    world_model: WorldModel,
    environment_change_log: list[dict[str, Any]],
    belief_ttl: timedelta = _DEFAULT_BELIEF_TTL,
    belief_dep_graph: Any | None = None,
    dep_graph_budget: Any | None = None,
) -> float:
    """Invalidate beliefs via TTL and environment_change_log, then decay dep graph edges.

    Returns stale_flag_ratio — the proportion of beliefs flagged stale after the sweep.
    Stores stale_flags and stale_flag_ratio as transient attributes on world_model.
    Calls apply_decay() at the end if belief_dep_graph and dep_graph_budget are provided.
    """
    stale_flags: dict[str, bool] = getattr(world_model, "stale_flags", {})
    now = datetime.now(UTC).replace(tzinfo=None)

    for belief in world_model.beliefs:
        belief_ts = belief.recorded_at
        if belief_ts.tzinfo is not None:
            belief_ts = belief_ts.replace(tzinfo=None)

        # TTL-based invalidation
        if now - belief_ts > belief_ttl:
            stale_flags[belief.id] = True
            continue

        # Environment-change-based invalidation
        belief_sources = set(belief.derived_from) | set(belief.supporting_evidence)
        for change in environment_change_log:
            affected_source = change.get("affected_source", "")
            if not affected_source or affected_source not in belief_sources:
                continue
            change_ts_raw = change.get("timestamp") or change.get("recorded_at")
            if change_ts_raw is None:
                continue
            try:
                change_ts = datetime.fromisoformat(str(change_ts_raw))
                if change_ts.tzinfo is not None:
                    change_ts = change_ts.replace(tzinfo=None)
            except ValueError:
                continue
            if change_ts > belief_ts:
                stale_flags[belief.id] = True
                break

    world_model.stale_flags = stale_flags  # type: ignore[attr-defined]

    belief_count = max(1, len(world_model.beliefs))
    stale_count = sum(1 for v in stale_flags.values() if v)
    ratio = stale_count / belief_count
    world_model.stale_flag_ratio = ratio  # type: ignore[attr-defined]

    # Edge decay — runs on the same schedule but is independent of belief staleness
    if belief_dep_graph is not None and dep_graph_budget is not None:
        from .belief_graph import apply_decay
        apply_decay(belief_dep_graph, dep_graph_budget)

    return ratio
