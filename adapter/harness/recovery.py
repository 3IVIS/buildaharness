"""
Recovery strategies — P6.2.

Six named strategies in a fixed progression. Advisory bias from the failure mode
library does not override caller decisions. Adaptive softmax upgrade falls back to
fixed order when experience_store is unavailable (INV-10).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Literal

StrategyType = Literal[
    "DIRECT_EDIT",
    "TRACE_EXEC",
    "BROADER_SEARCH",
    "REIMPLEMENT",
    "MINIMAL_FIX",
    "ESCALATE",
]

STRATEGY_ORDER: list[StrategyType] = [
    "DIRECT_EDIT",
    "TRACE_EXEC",
    "BROADER_SEARCH",
    "REIMPLEMENT",
    "MINIMAL_FIX",
    "ESCALATE",
]


@dataclass
class StrategyState:
    current_strategy: StrategyType = "DIRECT_EDIT"
    switch_count: int = 0
    switch_triggers: list[str] = field(default_factory=list)
    prior_strategy_weights: dict[str, float] = field(default_factory=dict)
    completion_history: list[int] = field(default_factory=list)
    risk_state_history: list[str] = field(default_factory=list)
    stall_reason: str = ""
    # P8 — tracks whether a recovery strategy was used in the current run
    recovery_was_used: bool = False
    # P8 — the failure class that triggered the most recent strategy switch
    last_failure_class: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "current_strategy": self.current_strategy,
            "switch_count": self.switch_count,
            "switch_triggers": list(self.switch_triggers),
            "prior_strategy_weights": dict(self.prior_strategy_weights),
            "completion_history": list(self.completion_history),
            "risk_state_history": list(self.risk_state_history),
            "stall_reason": self.stall_reason,
            "recovery_was_used": self.recovery_was_used,
            "last_failure_class": self.last_failure_class,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> StrategyState:
        return cls(
            current_strategy=d.get("current_strategy", "DIRECT_EDIT"),
            switch_count=d.get("switch_count", 0),
            switch_triggers=list(d.get("switch_triggers", [])),
            prior_strategy_weights=dict(d.get("prior_strategy_weights", {})),
            completion_history=list(d.get("completion_history", [])),
            risk_state_history=list(d.get("risk_state_history", [])),
            stall_reason=d.get("stall_reason", ""),
            recovery_was_used=d.get("recovery_was_used", False),
            last_failure_class=d.get("last_failure_class", ""),
        )


def get_next_strategy(strategy_state: StrategyState) -> StrategyType:
    """Return the next strategy in STRATEGY_ORDER. ESCALATE is terminal."""
    try:
        idx = STRATEGY_ORDER.index(strategy_state.current_strategy)
    except ValueError:
        idx = 0
    next_idx = min(idx + 1, len(STRATEGY_ORDER) - 1)
    return STRATEGY_ORDER[next_idx]


def switch_strategy(
    strategy_state: StrategyState,
    reason: str,
    failure_class: str = "",
    experience_store: Any | None = None,
) -> StrategyState:
    """Return a new StrategyState advanced to the next strategy (immutable update).

    When experience_store is available and failure_class is provided, uses
    build_strategy_ordering() to select the next strategy empirically (P8.4).
    Falls back to fixed STRATEGY_ORDER when the store is unavailable (INV-10).
    """
    if experience_store is not None and failure_class and getattr(experience_store, "available", False):
        from .experience_store import build_strategy_ordering
        ordering = build_strategy_ordering(failure_class, experience_store)
        try:
            idx = ordering.index(strategy_state.current_strategy)
        except ValueError:
            idx = 0
        next_idx = min(idx + 1, len(ordering) - 1)
        next_strategy: StrategyType = ordering[next_idx]  # type: ignore[assignment]
    else:
        next_strategy = get_next_strategy(strategy_state)

    return StrategyState(
        current_strategy=next_strategy,
        switch_count=strategy_state.switch_count + 1,
        switch_triggers=list(strategy_state.switch_triggers) + [reason],
        prior_strategy_weights=dict(strategy_state.prior_strategy_weights),
        completion_history=list(strategy_state.completion_history),
        risk_state_history=list(strategy_state.risk_state_history),
        stall_reason=strategy_state.stall_reason,
        recovery_was_used=True,
        last_failure_class=failure_class,
    )


def apply_failure_mode_bias(match_result: Any, strategy_state: StrategyState) -> StrategyType:
    """Return a strategy suggestion based on the failure mode match result.

    Advisory only — the caller decides whether to follow the suggestion.
    Returns get_next_strategy() if confidence < 0.7 or no affinity is set.
    """
    confidence = getattr(match_result, "normalised_confidence", 0.0)
    if confidence >= 0.7:
        affinity = getattr(match_result, "strategy_affinity", None)
        if affinity is not None and affinity in STRATEGY_ORDER:
            return affinity  # type: ignore[return-value]
    return get_next_strategy(strategy_state)


def get_strategy_with_experience(
    strategy_state: StrategyState,
    failure_class: str,
    experience_store: Any,
) -> StrategyType:
    """Return next strategy using softmax when experience_store is available (INV-10).

    Falls back transparently to get_next_strategy() when experience_store is absent
    or unavailable — the caller never needs to check experience_store.available directly.
    """
    if experience_store is None or not getattr(experience_store, "available", False):
        return get_next_strategy(strategy_state)

    try:
        weights_by_class: dict[str, dict[str, float]] = getattr(
            experience_store, "strategy_weights", {}
        )
        class_weights = weights_by_class.get(failure_class, {})
        if not class_weights:
            return get_next_strategy(strategy_state)

        values = {s: class_weights.get(s, 0.0) for s in STRATEGY_ORDER}
        max_v = max(values.values())
        exps = {s: math.exp(v - max_v) for s, v in values.items()}
        total = sum(exps.values())
        probs = {s: e / total for s, e in exps.items()}
        return max(probs, key=lambda s: probs[s])  # type: ignore[return-value]
    except Exception:
        return get_next_strategy(strategy_state)
