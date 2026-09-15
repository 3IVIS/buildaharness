"""
Caller state management — P0.4 / P7.

CallerState holds the mutable representation of the caller's requirements
as they evolve during a harness run. inject_clarification() is the single
write path — no code should mutate CallerState fields directly.

P7 additions: update_success_criteria(), escalation_pending, pending_clarification.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .escalation import AskAnswer, AskQuestion


@dataclass
class CallerState:
    current_constraints: list[str] = field(default_factory=list)
    clarification_history: list[dict[str, Any]] = field(default_factory=list)
    last_update: datetime | None = None
    output_preferences: dict[str, Any] = field(default_factory=dict)
    success_criteria: list[str] = field(default_factory=list)
    constraints_changed: bool = False
    # P7 escalation fields
    escalation_pending: bool = False
    pending_clarification: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "current_constraints": list(self.current_constraints),
            "clarification_history": list(self.clarification_history),
            "last_update": self.last_update.isoformat() if self.last_update else None,
            "output_preferences": dict(self.output_preferences),
            "success_criteria": list(self.success_criteria),
            "constraints_changed": self.constraints_changed,
            "escalation_pending": self.escalation_pending,
            "pending_clarification": self.pending_clarification,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> CallerState:
        return cls(
            current_constraints=d.get("current_constraints", []),
            clarification_history=d.get("clarification_history", []),
            last_update=datetime.fromisoformat(d["last_update"]) if d.get("last_update") else None,
            output_preferences=d.get("output_preferences", {}),
            success_criteria=d.get("success_criteria", []),
            constraints_changed=d.get("constraints_changed", False),
            escalation_pending=d.get("escalation_pending", False),
            pending_clarification=d.get("pending_clarification"),
        )


def describe_ask_answer(question: AskQuestion | None, answer: AskAnswer) -> str:
    """Render one AskAnswer as a distinct, kind-tagged constraint line — Q4 twin of
    escalate.ts's describeAskAnswer(). A "selected" pick, a "selected_with_edit"
    pick-plus-caveat, and a "free_text" answer must never collapse into one
    indistinguishable joined string once they reach current_constraints.
    """
    label = question.question if question is not None else answer.question_id
    if answer.kind == "selected":
        return f"Selected — {label}: {', '.join(answer.selected_labels or [])}"
    if answer.kind == "selected_with_edit":
        return f"Selected with note — {label}: {', '.join(answer.selected_labels or [])} (note: {answer.edit_text})"
    return f"Free-text answer — {label}: {answer.free_text}"


def inject_clarification(caller_state: CallerState, update: dict[str, Any]) -> None:
    """Apply a caller update to caller_state.

    Always appends to clarification_history — history is never truncated.
    Sets constraints_changed=True so the main loop knows to propagate the change.
    Full propagation path wired in P7.

    Q4 — a `clarification_answers` key (an AskResponse's answers) is handled distinctly
    from a plain `current_constraints` replacement: each AskAnswer is rendered via
    describe_ask_answer() and *appended* to current_constraints, using the optional
    `ask_questions` list (the original AskQuestion batch) to resolve question text.
    """
    caller_state.clarification_history.append(dict(update))

    if "current_constraints" in update:
        caller_state.current_constraints = list(update["current_constraints"])

    if "clarification_answers" in update:
        from .escalation import AskAnswer as _AskAnswer
        from .escalation import AskQuestion as _AskQuestion

        answers = [a if isinstance(a, _AskAnswer) else _AskAnswer.from_dict(a) for a in update["clarification_answers"]]
        raw_questions = update.get("ask_questions") or []
        questions = [q if isinstance(q, _AskQuestion) else _AskQuestion.from_dict(q) for q in raw_questions]
        by_id = {q.id: q for q in questions}
        caller_state.current_constraints = [
            *caller_state.current_constraints,
            *(describe_ask_answer(by_id.get(a.question_id), a) for a in answers),
        ]

    if "output_preferences" in update:
        caller_state.output_preferences.update(update["output_preferences"])

    if "success_criteria" in update:
        caller_state.success_criteria = list(update["success_criteria"])

    caller_state.last_update = datetime.now(UTC)
    caller_state.constraints_changed = True


def reset_constraints_changed(caller_state: CallerState) -> None:
    """Clear the constraints_changed flag after propagation has been applied."""
    caller_state.constraints_changed = False


def update_success_criteria(caller_state: CallerState, world_model: Any) -> None:
    """Mark beliefs as stale when they fall outside the updated success_criteria scope.

    Beliefs whose statement shares no tokens with any success criterion are
    flagged in world_model.stale_flags. Beliefs are never deleted — only flagged.
    """
    if not caller_state.success_criteria:
        return

    criteria_tokens: set[str] = set()
    for criterion in caller_state.success_criteria:
        criteria_tokens.update(criterion.lower().split())

    for belief in world_model.beliefs:
        statement_tokens = set(belief.statement.lower().split())
        if not (statement_tokens & criteria_tokens):
            world_model.stale_flags[belief.id] = True
