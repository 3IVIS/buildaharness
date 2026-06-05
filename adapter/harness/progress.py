"""
Stall detection — P6.1.

cannot_make_progress() detects four distinct stall patterns via measurable
proxies. Any single proxy returning True triggers recovery logic in the main loop.
Threshold constants are overridable via environment variables.
"""

from __future__ import annotations

import os
from typing import Any

# Steps with no completion advance before declaring a stall
STALL_WINDOW: int = int(os.environ.get("STALL_WINDOW", "5"))
# Strategy switches without progress before declaring a loop
MAX_SWITCHES: int = int(os.environ.get("MAX_SWITCHES", "3"))
# Consecutive same-failure-mode entries before declaring recurrence
RECURRENCE_THRESHOLD: int = int(os.environ.get("RECURRENCE_THRESHOLD", "3"))
# Steps over which risk-state oscillation is measured
OSCILLATION_WINDOW: int = int(os.environ.get("OSCILLATION_WINDOW", "6"))

_RISK_ORDER: dict[str, int] = {"NORMAL": 0, "CAUTIOUS": 1, "BLOCKED": 2}
_CAUTIOUS_LEVEL: int = _RISK_ORDER["CAUTIOUS"]


def _stalled_completion(strategy_state: Any, task_graph: Any) -> bool:
    """Proxy 1: returns True if no new tasks completed in the last STALL_WINDOW steps."""
    history: list[int] = getattr(strategy_state, "completion_history", [])
    if len(history) < STALL_WINDOW:
        return False
    window = history[-STALL_WINDOW:]
    return len(set(window)) == 1


def _strategy_looping(strategy_state: Any) -> bool:
    """Proxy 2: returns True if switch_count > MAX_SWITCHES with no completion advance."""
    if getattr(strategy_state, "switch_count", 0) <= MAX_SWITCHES:
        return False
    history: list[int] = getattr(strategy_state, "completion_history", [])
    if not history:
        return True
    return history[-1] == history[0]


def _failure_recurring(failure_diagnostics: Any) -> bool:
    """Proxy 3: returns True if the last RECURRENCE_THRESHOLD failures share the same class."""
    history = getattr(failure_diagnostics, "failure_history", [])
    if len(history) < RECURRENCE_THRESHOLD:
        return False
    recent = history[-RECURRENCE_THRESHOLD:]
    classes = [getattr(e, "failure_class", None) for e in recent]
    return len(set(classes)) == 1 and classes[0] is not None


def _risk_oscillating(strategy_state: Any) -> bool:
    """Proxy 4: returns True if risk state alternates across CAUTIOUS boundary >= 2 times."""
    history: list[str] = getattr(strategy_state, "risk_state_history", [])
    if len(history) < OSCILLATION_WINDOW:
        return False
    window = history[-OSCILLATION_WINDOW:]
    levels = [_RISK_ORDER.get(r, 0) for r in window]
    alternations = sum(
        1 for i in range(1, len(levels)) if (levels[i - 1] < _CAUTIOUS_LEVEL) != (levels[i] < _CAUTIOUS_LEVEL)
    )
    return alternations >= 2


def cannot_make_progress(
    strategy_state: Any,
    failure_diagnostics: Any,
    task_graph: Any,
) -> bool:
    """Return True if any of the four stall proxies fires.

    Short-circuits after the first True proxy. Records which proxy triggered in
    strategy_state.stall_reason for downstream logging.
    """
    if _stalled_completion(strategy_state, task_graph):
        if hasattr(strategy_state, "stall_reason"):
            strategy_state.stall_reason = "completion_velocity"
        return True
    if _strategy_looping(strategy_state):
        if hasattr(strategy_state, "stall_reason"):
            strategy_state.stall_reason = "strategy_loop"
        return True
    if _failure_recurring(failure_diagnostics):
        if hasattr(strategy_state, "stall_reason"):
            strategy_state.stall_reason = "failure_recurrence"
        return True
    if _risk_oscillating(strategy_state):
        if hasattr(strategy_state, "stall_reason"):
            strategy_state.stall_reason = "risk_oscillation"
        return True
    if hasattr(strategy_state, "stall_reason"):
        strategy_state.stall_reason = ""
    return False
