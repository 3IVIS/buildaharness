"""
Trajectory digest — bounded, human-readable input to the supervisor
(S0 of plans/harness_trajectory_supervisor_plan.html).

``build_digest()`` is a deterministic assembly step — no LLM call. It follows the
same contract as ``escalation.SurfaceBlocker``: the output carries **no** raw
``world_model`` JSON, no ``hypothesis_set`` / ``evidence_store`` entries, and every
list field is length-capped. Only scalar and short-string projections of the run
state are pulled through.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .recovery import STRATEGY_ORDER

# Field caps — the digest is a summary, never a dump.
_MAX_GOAL = 12
_MAX_LIST = 10
_MAX_STR = 240


def _clip(text: Any, limit: int = _MAX_STR) -> str:
    s = str(text or "").strip()
    return s if len(s) <= limit else s[: limit - 1] + "…"


def _cap(items: list[Any], limit: int = _MAX_LIST) -> list[Any]:
    return list(items[:limit])


@dataclass
class TrajectoryDigest:
    """A bounded snapshot of why a run is stuck. Safe to serialise into
    HarnessRunState and to hand verbatim to an LLM."""

    goal: list[str] = field(default_factory=list)
    steps_taken: int = 0
    stall_reason: str = ""
    stall_history: list[str] = field(default_factory=list)
    strategies_tried: list[dict[str, str]] = field(default_factory=list)
    failure_classes: list[dict[str, Any]] = field(default_factory=list)
    reopened_tasks: list[str] = field(default_factory=list)
    open_contradictions: list[str] = field(default_factory=list)
    blocking_unknowns: list[str] = field(default_factory=list)
    budget_remaining: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "goal": list(self.goal),
            "steps_taken": self.steps_taken,
            "stall_reason": self.stall_reason,
            "stall_history": list(self.stall_history),
            "strategies_tried": [dict(s) for s in self.strategies_tried],
            "failure_classes": [dict(f) for f in self.failure_classes],
            "reopened_tasks": list(self.reopened_tasks),
            "open_contradictions": list(self.open_contradictions),
            "blocking_unknowns": list(self.blocking_unknowns),
            "budget_remaining": dict(self.budget_remaining),
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any] | None) -> TrajectoryDigest:
        d = d or {}
        try:
            steps = int(d.get("steps_taken", 0))
        except (TypeError, ValueError):
            steps = 0
        return cls(
            goal=_cap([_clip(g) for g in (d.get("goal") or [])], _MAX_GOAL),
            steps_taken=max(0, steps),
            stall_reason=_clip(d.get("stall_reason", "")),
            stall_history=_cap([_clip(s, 80) for s in (d.get("stall_history") or [])]),
            strategies_tried=_cap(
                [
                    {"strategy": _clip(s.get("strategy", ""), 40), "outcome": _clip(s.get("outcome", ""), 80)}
                    for s in (d.get("strategies_tried") or [])
                    if isinstance(s, dict)
                ]
            ),
            failure_classes=_cap(
                [
                    {"class": _clip(f.get("class", ""), 80), "count": int(f.get("count", 0) or 0)}
                    for f in (d.get("failure_classes") or [])
                    if isinstance(f, dict)
                ]
            ),
            reopened_tasks=_cap([_clip(t) for t in (d.get("reopened_tasks") or [])]),
            open_contradictions=_cap([_clip(c) for c in (d.get("open_contradictions") or [])]),
            blocking_unknowns=_cap([_clip(u) for u in (d.get("blocking_unknowns") or [])]),
            budget_remaining=dict(d.get("budget_remaining") or {}),
        )


def _strategies_tried(strategy_state: Any) -> list[dict[str, str]]:
    """Reconstruct the strategy sequence from switch_count + switch_triggers.

    StrategyState keeps only the current strategy, a switch count, and the trigger
    reason recorded at each switch — not a full strategy log. Walking STRATEGY_ORDER
    up to switch_count reproduces the sequence that was actually stepped through.
    """
    switch_count = int(getattr(strategy_state, "switch_count", 0) or 0)
    triggers = list(getattr(strategy_state, "switch_triggers", []))
    out: list[dict[str, str]] = []
    for i in range(min(switch_count, len(STRATEGY_ORDER))):
        out.append(
            {
                "strategy": STRATEGY_ORDER[i],
                "outcome": _clip(triggers[i], 80) if i < len(triggers) else "switched",
            }
        )
    current = getattr(strategy_state, "current_strategy", "")
    if current and (not out or out[-1]["strategy"] != current):
        out.append({"strategy": _clip(current, 40), "outcome": "current"})
    return _cap(out)


def _failure_classes(failure_diagnostics: Any) -> list[dict[str, Any]]:
    history = getattr(failure_diagnostics, "failure_history", []) if failure_diagnostics is not None else []
    counts: dict[str, int] = {}
    for entry in history:
        fc = getattr(entry, "failure_class", None) or (entry.get("failure_class") if isinstance(entry, dict) else None)
        if fc:
            counts[str(fc)] = counts.get(str(fc), 0) + 1
    ranked = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)
    return [{"class": _clip(fc, 80), "count": n} for fc, n in ranked[:_MAX_LIST]]


def _open_contradictions(world_model: Any) -> list[str]:
    out: list[str] = []
    for c in getattr(world_model, "contradictions", []):
        if getattr(c, "severity", "") != "HIGH":
            continue
        desc = getattr(c, "description", "") or ""
        cid = getattr(c, "id", "?")
        if desc:
            out.append(_clip(f"{cid}: {desc}"))
        else:
            involved = ", ".join(getattr(c, "involved_belief_ids", [])[:4])
            out.append(_clip(f"{cid}: beliefs {involved}"))
    return _cap(out)


def _blocking_unknowns(world_model: Any, harness_run_state: Any) -> list[str]:
    out: list[str] = [_clip(a) for a in getattr(world_model, "assumptions", []) if str(a or "").strip()]
    pending = getattr(harness_run_state, "pending_escalation", None) if harness_run_state is not None else None
    for m in getattr(pending, "missing_info", []) or []:
        out.append(_clip(m))
    return _cap(out)


def build_digest(
    strategy_state: Any,
    failure_diagnostics: Any,
    task_graph: Any,
    world_model: Any,
    *,
    caller_state: Any | None = None,
    recovery_budget: Any | None = None,
    reopened_task_descriptions: list[str] | None = None,
    harness_run_state: Any | None = None,
) -> TrajectoryDigest:
    """Assemble a bounded TrajectoryDigest from live run state. Deterministic; no LLM."""
    success_criteria = list(getattr(caller_state, "success_criteria", []) or [])
    completion_history = list(getattr(strategy_state, "completion_history", []) or [])

    failed = [
        _clip(getattr(t, "description", "") or getattr(t, "id", ""))
        for t in getattr(task_graph, "tasks", [])
        if getattr(t, "status", "") == "FAILED"
    ]
    reopened = list(reopened_task_descriptions or []) + failed

    return TrajectoryDigest(
        goal=_cap([_clip(c) for c in success_criteria], _MAX_GOAL),
        steps_taken=len(completion_history),
        stall_reason=_clip(getattr(strategy_state, "stall_reason", "")),
        stall_history=_cap([_clip(t, 80) for t in getattr(strategy_state, "switch_triggers", [])]),
        strategies_tried=_strategies_tried(strategy_state),
        failure_classes=_failure_classes(failure_diagnostics),
        reopened_tasks=_cap([r for r in reopened if r]),
        open_contradictions=_open_contradictions(world_model),
        blocking_unknowns=_blocking_unknowns(world_model, harness_run_state),
        budget_remaining=recovery_budget.to_dict() if recovery_budget is not None else {},
    )
