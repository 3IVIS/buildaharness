"""Write-route decision (M6 ``resolveWriteRoute``). Pure and structural: reads bits, never text."""

from __future__ import annotations

from ._core_generated import DEFAULT_WRITE_MODE, WRITE_MODES
from .model import Fact

IN_TURN = "in_turn"


def resolve_write_mode(raw: object) -> str:
    """Unknown or absent values resolve to the default: a typo must never widen write authority."""
    return raw if isinstance(raw, str) and raw in WRITE_MODES else DEFAULT_WRITE_MODE


def resolve_write_route(mode: str, writer: str, fact: Fact) -> str:
    """Where a candidate may land: ``durable``, ``pending`` or ``session``.

    ``mode`` is normalised through ``resolve_write_mode`` so an invalid mode behaves as the default.
    """
    mode = resolve_write_mode(mode)
    if writer == IN_TURN:
        if fact.source != "model_inferred":
            return "durable" if fact.durable else "session"
        if not fact.durable:
            return "session"
        if fact.confidence == "high":
            return "pending" if mode == "user_only" else "durable"
        if fact.confidence == "medium":
            return "pending"
        return "session"
    # Cross-turn writers: only a durable, non-low-confidence candidate is worth more than session scope.
    if not fact.durable or fact.confidence == "low":
        return "session"
    return "durable" if mode == "auto" else "pending"
