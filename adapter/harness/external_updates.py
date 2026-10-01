"""
External update poll — P7.1.

check_external_updates() is a non-blocking poll inserted at the top of every
main loop iteration. It must complete in under 10ms when no update is available
and must never raise regardless of transport failure.

Implement UpdateChannel for any transport (Postgres LISTEN/NOTIFY, Redis pubsub,
webhook inbox). The default NoOpUpdateChannel always returns None.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

UpdateType = Literal["constraint", "clarification", "success_criteria"]

# Keys a clarification payload may carry the human's free-text answer under, in
# priority order. Everything else in the payload is treated as metadata.
_ANSWER_KEYS = ("answer", "clarification", "response", "text", "message")
_MAX_ANSWER_LEN = 600


def _clarification_answer_text(payload: dict[str, Any]) -> str:
    """Best-effort extraction of the human's answer from a clarification payload.

    Empty / whitespace-only answers return "" (the caller records nothing but never
    crashes); an over-long answer is clipped. A value not among a supervisor's
    offered options is accepted verbatim as free-form — options are a hint, not a
    constraint (mirrors AskUserQuestion's always-available "Other")."""
    if not isinstance(payload, dict):
        return ""
    for key in _ANSWER_KEYS:
        v = payload.get(key)
        if isinstance(v, str) and v.strip():
            return v.strip()[:_MAX_ANSWER_LEN]
    for key, v in payload.items():
        if key in ("update_type", "options", "current_constraints", "success_criteria", "output_preferences"):
            continue
        if isinstance(v, str) and v.strip():
            return v.strip()[:_MAX_ANSWER_LEN]
    return ""


@dataclass
class PendingUpdate:
    update_type: UpdateType
    payload: dict[str, Any]
    received_at: datetime = field(default_factory=lambda: datetime.now(UTC))


class UpdateChannel(ABC):
    """Abstract interface for external update channels.

    poll() must complete in under 10ms and must never raise.
    """

    @abstractmethod
    def poll(self) -> PendingUpdate | None:
        """Return a pending update if one is available, else None."""


class NoOpUpdateChannel(UpdateChannel):
    """Default channel — always returns None. Zero overhead."""

    def poll(self) -> PendingUpdate | None:
        return None


class PostgresNotifyChannel(UpdateChannel):
    """Non-blocking LISTEN/NOTIFY channel via psycopg2.

    Uses psycopg2 non-blocking connection.poll() to check for pending
    notifications without waiting. Transport failures return None silently.
    """

    def __init__(self, connection: Any, channel_name: str = "harness_updates") -> None:
        self._conn = connection
        self._channel_name = channel_name
        self._listening = False

    def _ensure_listening(self) -> None:
        if not self._listening:
            cursor = self._conn.cursor()
            cursor.execute(f"LISTEN {self._channel_name}")
            cursor.close()
            self._conn.commit()
            self._listening = True

    def poll(self) -> PendingUpdate | None:
        try:
            self._ensure_listening()
            self._conn.poll()
            if self._conn.notifies:
                notify = self._conn.notifies.pop(0)
                import json

                raw = json.loads(notify.payload) if notify.payload else {}
                update_type: UpdateType = raw.pop("update_type", "clarification")
                return PendingUpdate(update_type=update_type, payload=raw)
        except Exception:
            pass
        return None


def take_budget_answers(payload: dict[str, Any], memory_state: Any, task_graph: Any) -> dict[str, Any] | None:
    """Act on the user's answer to the budget_exhausted question and remove it from the update (TS takeBudgetAnswers).

    An answer to the budget question is a CONTROL action, not a scope constraint, so it never reaches the constraint
    pipeline. Options are recognised by the exact labels the question builder produced:
      - "Continue with N more steps": memory_state.max_steps grows by DEFAULT_BUDGET_EXTENSION;
      - "Stop and summarize progress so far": every unfinished task is cancelled (`goal_cancelled`);
      - "Let me clarify the goal": no budget effect; the answer stays a constraint.
    Returns the update without the budget answers, or None when nothing else was in it.
    """
    from .ask_question import DEFAULT_BUDGET_EXTENSION, build_budget_exhausted_question
    from .constraint_propagation import cancel_task_graph

    answers = payload.get("clarification_answers")
    if not isinstance(answers, list):
        return payload

    template = build_budget_exhausted_question(0)
    assert template.options is not None
    continue_label, stop_label = template.options[0].label, template.options[1].label

    def question_id(a: Any) -> Any:
        return a.get("questionId") if isinstance(a, dict) else getattr(a, "question_id", None)

    def labels(a: Any) -> Any:
        return a.get("selectedLabels") if isinstance(a, dict) else getattr(a, "selected_labels", None)

    budget = [a for a in answers if question_id(a) == template.id]
    if not budget:
        return payload
    for answer in budget:
        selected = labels(answer)
        if not isinstance(selected, list):
            continue
        if continue_label in selected:
            if memory_state is not None:
                memory_state.max_steps += DEFAULT_BUDGET_EXTENSION
        elif stop_label in selected and task_graph is not None:
            cancel_task_graph(task_graph)

    rest = [a for a in answers if question_id(a) != template.id]
    if not rest:
        return None
    return {**payload, "clarification_answers": rest}


def check_external_updates(
    channel: UpdateChannel,
    caller_state: Any,
    world_model: Any,
    task_graph: Any,
    diagnostics: Any,
    output_contract: Any | None = None,
    memory_state: Any | None = None,
) -> bool:
    """Non-blocking poll for external constraint updates.

    Inserted at the top of every main loop iteration before staleness_sweep()
    and update_diagnostics(). Must complete in under 10ms when no update is
    available — verified by T01 acceptance test.

    Returns True if an update was processed (caller must re-resolve control_state).
    Returns False if no update was available (no state mutation).

    Transport or parse failures return False silently — the loop never crashes
    due to channel unavailability.
    """
    from .caller_state import inject_clarification, reset_constraints_changed
    from .constraint_propagation import apply_constraint_change_propagation, cancel_task_graph
    from .output_contract import OutputContract
    from .world_model import Observation

    try:
        update = channel.poll()
    except Exception:
        return False

    if update is None:
        return False

    remaining = take_budget_answers(update.payload, memory_state, task_graph)
    if remaining is None:
        return False  # the whole update was an answer to the budget question, handled as a control action
    if remaining is not update.payload:
        update = PendingUpdate(update_type=update.update_type, payload=remaining, received_at=update.received_at)

    inject_clarification(caller_state, update.payload)

    # Python-only: the resumed answer is also recorded as a HIGH-provenance user_clarification
    # observation (harness-runtime.ts documents the same outcome for its resumed run).
    if update.update_type == "clarification" and world_model is not None and hasattr(world_model, "add_observation"):
        answer = _clarification_answer_text(update.payload)
        if answer:
            import uuid as _uuid

            world_model.add_observation(
                Observation(
                    id=f"clarify-{_uuid.uuid4().hex[:8]}",
                    content=f"User clarification: {answer}",
                    source="user_clarification",
                )
            )

    if not caller_state.constraints_changed:
        return False

    # TS checkCallerUpdates: `cancel_current: true` cancels the whole graph instead of re-scoping it.
    if update.payload.get("cancel_current") is True:
        cancel_task_graph(task_graph)
        world_model.generation_id += 1
        reset_constraints_changed(caller_state)
        return True

    oc = output_contract if output_contract is not None else OutputContract()
    # apply_constraint_change_propagation bumps generation_id and clears constraints_changed itself.
    apply_constraint_change_propagation(caller_state, world_model, task_graph, oc, diagnostics)
    return True
