"""
Escalation with surface_blocker — P7.3.

escalate() is the structured halt point at which the harness surfaces minimum
required information to the human and pauses the run. After a human response
arrives via the resume endpoint, await_clarification() retrieves it and the
constraint change propagation path (P7.2) handles the update.

SurfaceBlocker carries only human-readable context — no raw world_model dumps,
no hypothesis_set, no evidence_store entries.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, Literal

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

EscalationReason = Literal[
    "blocked_state",
    "cannot_make_progress",
    "budget_exhausted",
    "review_failure",
    "action_requires_compressed_state",
]


@dataclass
class SurfaceBlocker:
    """Minimum structured information surfaced to a human when the harness halts.

    Carries exactly: reason, missing_info, current_task_summary, escalated_at.
    Must not contain raw world_model JSON, hypothesis_set data, or evidence_store
    entries — the escalation is human-readable, not a debug dump.
    """

    reason: EscalationReason
    missing_info: list[str]
    current_task_summary: str
    escalated_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    def to_dict(self) -> dict[str, Any]:
        return {
            "reason": self.reason,
            "missing_info": list(self.missing_info),
            "current_task_summary": self.current_task_summary,
            "escalated_at": self.escalated_at.isoformat(),
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> SurfaceBlocker:
        return cls(
            reason=d["reason"],
            missing_info=d.get("missing_info", []),
            current_task_summary=d.get("current_task_summary", ""),
            escalated_at=datetime.fromisoformat(d["escalated_at"]) if d.get("escalated_at") else datetime.now(UTC),
        )


class EscalationHalt(Exception):
    """Non-error exception raised by escalate() to halt the loop.

    The loop runner catches this and converts the run to a paused state.
    """

    def __init__(self, blocker: SurfaceBlocker) -> None:
        self.blocker = blocker
        super().__init__(f"Escalation halt: {blocker.reason}")


def escalate(
    surface_blocker: SurfaceBlocker,
    harness_run_state: Any,
    run_id: str,
) -> None:
    """Halt the harness run and surface the blocker for human review.

    Steps:
    1. Set harness_run_state.escalation_pending = True
    2. Store surface_blocker as harness_run_state.pending_escalation
    3. Emit a structured log entry to the execution_journal
    4. Raise EscalationHalt — caught by the loop runner to pause the run

    Note: DB persistence (step 4 in the plan) is handled by the loop runner
    after catching EscalationHalt, since save() is async and escalate() is sync.
    """
    harness_run_state.escalation_pending = True
    harness_run_state.pending_escalation = surface_blocker

    if hasattr(harness_run_state, "memory_state") and harness_run_state.memory_state is not None:
        ms = harness_run_state.memory_state
        if hasattr(ms, "journal"):
            ms.journal.append(
                {
                    "action_class": "escalation",
                    "reason": surface_blocker.reason,
                    "missing_info": surface_blocker.missing_info,
                    "run_id": run_id,
                    "escalated_at": surface_blocker.escalated_at.isoformat(),
                }
            )

    raise EscalationHalt(surface_blocker)


async def await_clarification(run_id: str, db: AsyncSession) -> Any | None:
    """Check if a human response has been posted for the escalated run.

    Returns None if no response is available yet — the caller (resume endpoint)
    should exit early and let the caller retry.

    Returns a PendingUpdate when a response is present. Clears pending_clarification
    and escalation_pending on HarnessRunState before returning.
    """
    from .external_updates import PendingUpdate
    from .state_store import load as _load
    from .state_store import save as _save

    state = await _load(run_id, db)
    if state is None:
        return None

    if state.pending_clarification is None:
        return None

    payload = dict(state.pending_clarification)
    update_type = payload.pop("update_type", "clarification")

    state.pending_clarification = None
    state.escalation_pending = False

    if hasattr(state, "caller_state"):
        state.caller_state.escalation_pending = False
        state.caller_state.pending_clarification = None

    await _save(run_id, state, db)

    return PendingUpdate(update_type=update_type, payload=payload)
