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


def check_external_updates(
    channel: UpdateChannel,
    caller_state: Any,
    world_model: Any,
    task_graph: Any,
    diagnostics: Any,
    output_contract: Any | None = None,
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
    from .caller_state import inject_clarification
    from .constraint_propagation import apply_constraint_change_propagation
    from .output_contract import OutputContract
    from .staleness import increment_generation_id

    try:
        update = channel.poll()
    except Exception:
        return False

    if update is None:
        return False

    inject_clarification(caller_state, update.payload)

    oc = output_contract if output_contract is not None else OutputContract()
    apply_constraint_change_propagation(caller_state, world_model, task_graph, oc, diagnostics)

    increment_generation_id(world_model)

    return True
