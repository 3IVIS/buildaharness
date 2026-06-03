"""
Caller state management — P0.4.

CallerState holds the mutable representation of the caller's requirements
as they evolve during a harness run. inject_clarification() is the single
write path — no code should mutate CallerState fields directly.

Full constraint-change propagation (detect_contradictions, revalidate_task_graph,
generation_id increment, control_state refresh) is wired in P7.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any


@dataclass
class CallerState:
    current_constraints: list[str] = field(default_factory=list)
    clarification_history: list[dict[str, Any]] = field(default_factory=list)
    last_update: datetime | None = None
    output_preferences: dict[str, Any] = field(default_factory=dict)
    success_criteria: list[str] = field(default_factory=list)
    constraints_changed: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "current_constraints": list(self.current_constraints),
            "clarification_history": list(self.clarification_history),
            "last_update": self.last_update.isoformat() if self.last_update else None,
            "output_preferences": dict(self.output_preferences),
            "success_criteria": list(self.success_criteria),
            "constraints_changed": self.constraints_changed,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "CallerState":
        return cls(
            current_constraints=d.get("current_constraints", []),
            clarification_history=d.get("clarification_history", []),
            last_update=datetime.fromisoformat(d["last_update"]) if d.get("last_update") else None,
            output_preferences=d.get("output_preferences", {}),
            success_criteria=d.get("success_criteria", []),
            constraints_changed=d.get("constraints_changed", False),
        )


def inject_clarification(caller_state: CallerState, update: dict[str, Any]) -> None:
    """Apply a caller update to caller_state.

    Always appends to clarification_history — history is never truncated.
    Sets constraints_changed=True so the main loop knows to propagate the change.
    Full propagation path wired in P7.
    """
    caller_state.clarification_history.append(dict(update))

    if "current_constraints" in update:
        caller_state.current_constraints = list(update["current_constraints"])

    if "output_preferences" in update:
        caller_state.output_preferences.update(update["output_preferences"])

    if "success_criteria" in update:
        caller_state.success_criteria = list(update["success_criteria"])

    caller_state.last_update = datetime.now(UTC)
    caller_state.constraints_changed = True


def reset_constraints_changed(caller_state: CallerState) -> None:
    """Clear the constraints_changed flag after propagation has been applied."""
    caller_state.constraints_changed = False
