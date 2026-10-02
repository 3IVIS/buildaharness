"""Audit-log construction, rotation and undo planning (M2 audit log). Pure: no clock, no I/O.

The caller supplies ``at`` (ISO string) and the current log; every function returns new values.
Entries only ever hold post-gate text (the redaction invariant): nothing here sees a raw candidate.
The ops ``archive``/``restore`` and the ``group``/``erased`` fields are deferred: they are read
and preserved, never written, and undo of such an entry returns a fixed refusal.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace

from ._core_generated import AUDIT_LOG_KEEP, AUDIT_OPS_DEFERRED, UNDO_MESSAGES
from .model import AuditDraft, AuditEntry, Fact, PendingFact, RejectedFact, same_fact

DEFERRED_OPS = frozenset(AUDIT_OPS_DEFERRED)


def next_seq(log: list[AuditEntry]) -> int:
    """Last entry's seq (strictly increasing), or 0 for an empty log."""
    return log[-1].seq if log else 0


def rotate_audit(entries: list[AuditEntry], keep: int = AUDIT_LOG_KEEP, watermark: int = 0) -> list[AuditEntry]:
    """Keep the last ``keep`` entries plus any entry newer than the consolidation ``watermark``.

    Mirrors the TS rule exactly, including its consequence: the default watermark is 0 and every
    seq is above 0, so no entry is rotated away until a consolidation watermark has been written.
    """
    if len(entries) <= keep:
        return list(entries)
    cutoff = len(entries) - keep
    return [e for i, e in enumerate(entries) if i >= cutoff or e.seq > watermark]


def build_entries(log: list[AuditEntry], drafts: list[AuditDraft], at: str) -> list[AuditEntry]:
    """Assign consecutive seqs (continuing from the log) and the injected ``at`` to ``drafts``."""
    seq = next_seq(log)
    out: list[AuditEntry] = []
    for d in drafts:
        seq += 1
        out.append(
            AuditEntry(
                seq=seq,
                at=at,
                op=d.op,
                fact_id=d.fact_id,
                store=d.store,
                writer=d.writer,
                turn=d.turn,
                before=d.before,
                after=d.after,
                undoes=d.undoes,
                index=d.index,
            )
        )
    return out


def append_audit(
    log: list[AuditEntry],
    drafts: list[AuditDraft],
    at: str,
    *,
    keep: int = AUDIT_LOG_KEEP,
    watermark: int = 0,
) -> list[AuditEntry]:
    """The log after appending ``drafts`` and rotating. No drafts means the log is returned unchanged."""
    if not drafts:
        return list(log)
    return rotate_audit([*log, *build_entries(log, drafts, at)], keep, watermark)


@dataclass(frozen=True)
class UndoSnapshot:
    """The stores an undo may touch, as lists (``None`` = absent, distinct from empty)."""

    durable: list[Fact] = field(default_factory=list)
    pending: list[Fact] | None = None
    retired: list[Fact] | None = None
    rejected: list[RejectedFact] | None = None


@dataclass(frozen=True)
class UndoPlan:
    """What an undo does. ``ok=False`` means nothing changes. Store fields are ``None`` when untouched.

    ``set_or_clear`` for retired follows TS ``setOrClear``: an empty result means *delete the key*
    (``retired_absent``), so undoing the change that created a side store leaves it absent.
    """

    ok: bool
    message: str
    durable: list[Fact] | None = None
    pending: list[Fact] | None = None
    retired: list[Fact] | None = None
    retired_absent: bool = False
    rejected: list[RejectedFact] | None = None
    draft: AuditDraft | None = None


def refuse(message: str) -> UndoPlan:
    return UndoPlan(ok=False, message=message)


def check_undoable(log: list[AuditEntry], seq: int) -> tuple[AuditEntry | None, str | None]:
    """Ordered refusal rules; returns ``(entry, None)`` when undo may proceed, else ``(None, message)``."""
    entry = next((e for e in log if e.seq == seq), None)
    if entry is None:
        return None, UNDO_MESSAGES["unknown_seq"].format(seq=seq)
    if entry.op == "undo":
        return None, UNDO_MESSAGES["is_undo"].format(seq=seq)
    if any(e.undoes == seq for e in log):
        return None, UNDO_MESSAGES["already_undone"].format(seq=seq)
    if entry.erased:
        return None, UNDO_MESSAGES["erased"].format(seq=seq)
    if entry.group or entry.op in DEFERRED_OPS:
        return None, UNDO_MESSAGES["grouped"].format(seq=seq)
    return entry, None


def _without(items: list, f: Fact | None) -> list:
    return list(items) if f is None else [x for x in items if not same_fact(x, f)]


def _insert_at(items: list[Fact], f: Fact, index: int | None) -> list[Fact]:
    if index is None or index < 0 or index > len(items):
        return [*items, f]
    return [*items[:index], f, *items[index:]]


def plan_undo(log: list[AuditEntry], seq: int, snapshot: UndoSnapshot, session_id: str = "undo") -> UndoPlan:
    """Plan the exact-restore undo of one audit entry (pure; the caller applies it and appends ``draft``)."""
    entry, refusal = check_undoable(log, seq)
    if entry is None:
        return refuse(refusal or "")
    message = UNDO_MESSAGES["success"].format(
        seq=seq,
        op=entry.op,
        text=(entry.before or entry.after).text if (entry.before or entry.after) else entry.fact_id,
    )
    draft = AuditDraft(
        op="undo",
        fact_id=entry.fact_id,
        before=entry.after,
        after=entry.before,
        store=entry.store,
        writer="undo",
        turn=session_id,
        undoes=entry.seq,
    )
    durable: list[Fact] | None = None
    pending: list[Fact] | None = None
    retired: list[Fact] | None = None
    retired_absent = False
    rejected: list[RejectedFact] | None = None
    if entry.store == "durable":
        nd = _without(snapshot.durable, entry.after)
        if entry.before is not None and entry.op != "confirm":
            stripped = replace(entry.before, retired_at=None)
            nd = _insert_at(_without(nd, entry.before), stripped, entry.index)
        durable = nd
        if entry.op in ("replace", "retire"):
            left = _without(snapshot.retired or [], entry.before)
            retired, retired_absent = (left, False) if left else (None, True)
        if entry.op == "confirm" and entry.before is not None:
            pending = [*_without(snapshot.pending or [], entry.before), entry.before]
    elif entry.store == "pending":
        base = snapshot.pending or []
        pending = (
            [*_without(base, entry.before), entry.before] if entry.before is not None else _without(base, entry.after)
        )
        if entry.op == "reject" and entry.before is not None:
            rejected = [r for r in (snapshot.rejected or []) if r.text != entry.before.text]
    return UndoPlan(True, message, durable, pending, retired, retired_absent, rejected, draft)


__all__ = [
    "AuditDraft",
    "AuditEntry",
    "PendingFact",
    "UndoPlan",
    "UndoSnapshot",
    "append_audit",
    "build_entries",
    "check_undoable",
    "next_seq",
    "plan_undo",
    "rotate_audit",
]
