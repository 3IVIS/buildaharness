"""
generation_id staleness tracking infrastructure — P0.3.

Provides the increment helper, staleness predicate, and gate-assertion
decorator. Full gate logic is added in P3; the stubs in gates.py use this
module but raise NotImplementedError so callers cannot accidentally treat
an unimplemented gate as a real gate.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from functools import wraps
from typing import Any

from .world_model import WorldModel


class StalenessError(Exception):
    """Raised by @assert_generation_fresh when control_state.generation_id lags world_model."""


@dataclass
class ControlStateStub:
    """Minimal placeholder used by P0.3 tests and gate stubs.

    Replaced by the full ControlState from P3 once diagnostics and
    resolve_control_state() are implemented.
    """

    generation_id: int = 0
    # Additional fields added in P3
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
