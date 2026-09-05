"""
Recovery strategies — P6.2.

Six named strategies in a fixed progression. Advisory bias from the failure mode
library does not override caller decisions. Adaptive softmax upgrade falls back to
fixed order when experience_store is unavailable (INV-10).

RecoveryBudget (Phase 2 of plans/harness_and_assistant_architecture_remediation_plan.html):
before this, the only bound on "how much recovery is too much" was implicitly
STRATEGY_ORDER's fixed length (6) — reaching the terminal "ESCALATE" strategy already
triggers escalation in loop.py, but that's a strategy-switch count, not a real resource
budget. RecoveryBudget adds genuine multi-dimensional bounds (tool calls, cost, wall-clock
time, plan revisions) alongside it, not instead of it — exhausting either still escalates
through the same existing surface-blocker path.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Literal

from ._core_generated import RECOVERY_CLASSIFICATION_TABLE

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


# ── Failure → Classification → Recovery Policy → Selected Action (criticism002 #7) ──
#
# Phase C2 (docs/adr/004-shared-semantic-core.md) lands this table as DATA + TYPES
# only. RECOVERY_CLASSIFICATION_TABLE is generated from spec/harness-core.json into
# ._core_generated, shared byte-for-byte with packages/harness/src/recovery-policy.ts.
# classify_recovery() is a pure lookup: a CLASSIFIED failure resolves to a
# RecoveryPolicy naming the short-circuit action; an UNCLASSIFIED failure returns
# None and the caller falls through to get_next_strategy(STRATEGY_ORDER) + softmax
# unchanged. Wiring this into switch_strategy() / loop.py is Phase D — nothing in
# this module calls classify_recovery() yet.


@dataclass(frozen=True)
class RecoveryPolicy:
    failure_class: str
    policy: str
    action: str


def classify_recovery(failure_class: str | None) -> RecoveryPolicy | None:
    """Map a failure class to its deterministic recovery policy, or None if unclassified.

    None (the common case today) means "no short-circuit — use the existing
    strategy progression". This never raises: an unknown class is simply unclassified.
    """
    if not failure_class:
        return None
    entry = RECOVERY_CLASSIFICATION_TABLE.get(failure_class)
    if entry is None:
        return None
    return RecoveryPolicy(failure_class=failure_class, policy=entry["policy"], action=entry["action"])


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


@dataclass(frozen=True)
class RecoveryBudget:
    """Bounds how much recovery effort a single objective may consume. Immutable, like
    StrategyState — consume() returns a new instance rather than mutating in place, so a
    caller can't accidentally share/alias a budget across two objectives.

    Any single exhausted dimension exhausts the whole budget — recovery isn't allowed to
    keep going on cost alone once it's burned through its plan-revision allowance, etc.
    """

    max_tool_calls: int = 20
    max_cost: float = 2.0
    max_time_seconds: float = 300.0
    max_plan_revisions: int = 3

    tool_calls_used: int = 0
    cost_used: float = 0.0
    time_used_seconds: float = 0.0
    plan_revisions_used: int = 0

    def is_exhausted(self) -> bool:
        return (
            self.tool_calls_used >= self.max_tool_calls
            or self.cost_used >= self.max_cost
            or self.time_used_seconds >= self.max_time_seconds
            or self.plan_revisions_used >= self.max_plan_revisions
        )

    def consume(
        self,
        *,
        tool_calls: int = 0,
        cost: float = 0.0,
        time_seconds: float = 0.0,
        plan_revisions: int = 0,
    ) -> RecoveryBudget:
        return RecoveryBudget(
            max_tool_calls=self.max_tool_calls,
            max_cost=self.max_cost,
            max_time_seconds=self.max_time_seconds,
            max_plan_revisions=self.max_plan_revisions,
            tool_calls_used=self.tool_calls_used + tool_calls,
            cost_used=self.cost_used + cost,
            time_used_seconds=self.time_used_seconds + time_seconds,
            plan_revisions_used=self.plan_revisions_used + plan_revisions,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "max_tool_calls": self.max_tool_calls,
            "max_cost": self.max_cost,
            "max_time_seconds": self.max_time_seconds,
            "max_plan_revisions": self.max_plan_revisions,
            "tool_calls_used": self.tool_calls_used,
            "cost_used": self.cost_used,
            "time_used_seconds": self.time_used_seconds,
            "plan_revisions_used": self.plan_revisions_used,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> RecoveryBudget:
        return cls(
            max_tool_calls=d.get("max_tool_calls", 20),
            max_cost=d.get("max_cost", 2.0),
            max_time_seconds=d.get("max_time_seconds", 300.0),
            max_plan_revisions=d.get("max_plan_revisions", 3),
            tool_calls_used=d.get("tool_calls_used", 0),
            cost_used=d.get("cost_used", 0.0),
            time_used_seconds=d.get("time_used_seconds", 0.0),
            plan_revisions_used=d.get("plan_revisions_used", 0),
        )


def get_next_strategy(strategy_state: StrategyState, order: list[str] | None = None) -> StrategyType:
    """Return the next strategy in ``order`` (default STRATEGY_ORDER). The last entry is terminal.

    ``order`` lets callers supply a domain-specific strategy sequence (e.g. a
    canvas node's ``strategy_order_override``) instead of the generic dev-flow
    STRATEGY_ORDER. Falls back to STRATEGY_ORDER when not given.
    """
    sequence = order or STRATEGY_ORDER
    try:
        idx = sequence.index(strategy_state.current_strategy)
    except ValueError:
        idx = 0
    next_idx = min(idx + 1, len(sequence) - 1)
    return sequence[next_idx]  # type: ignore[return-value]


def switch_strategy(
    strategy_state: StrategyState,
    reason: str,
    failure_class: str = "",
    experience_store: Any | None = None,
    order: list[str] | None = None,
) -> StrategyState:
    """Return a new StrategyState advanced to the next strategy (immutable update).

    When experience_store is available and failure_class is provided, uses
    build_strategy_ordering() to select the next strategy empirically (P8.4).
    Falls back to fixed STRATEGY_ORDER when the store is unavailable (INV-10).
    ``order`` (e.g. a recovery_node's strategy_order_override) takes precedence
    over the experience-store ordering and is used for the plain fallback path.
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
        next_strategy = get_next_strategy(strategy_state, order)

    return StrategyState(
        current_strategy=next_strategy,
        switch_count=strategy_state.switch_count + 1,
        switch_triggers=[*list(strategy_state.switch_triggers), reason],
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
        weights_by_class: dict[str, dict[str, float]] = getattr(experience_store, "strategy_weights", {})
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
