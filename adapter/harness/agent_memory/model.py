"""Wire-compatible data model for agent memory (M8 port of the TS UserFact family).

Pure data: no I/O, no clock, no DB imports. The wire format is the TS one (camelCase JSON);
every dataclass exposes ``to_dict()``/``from_dict()`` in that format. Optional fields that are
``None`` are omitted from the wire form, matching TS ``undefined``. Unknown wire keys are
preserved nowhere and ignored on read (the contract lists the fields that exist).

``Fact.judgement`` is transient: it is carried from the extractor to the write gate and is
never part of ``to_dict()`` output.
"""

from __future__ import annotations

from dataclasses import dataclass, field, fields, replace
from typing import Any


def _camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(p.title() for p in rest)


@dataclass(frozen=True)
class CandidateJudgement:
    """The extractor's per-fact judgement. ``None`` for either boolean means *missing* (fail closed)."""

    contains_secret: bool | None = None
    redacted_text: str | None = None
    looks_like_instruction: bool | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for f in fields(self):
            v = getattr(self, f.name)
            if v is not None:
                out[_camel(f.name)] = v
        return out

    @classmethod
    def from_dict(cls, d: dict[str, Any] | None) -> CandidateJudgement | None:
        if not isinstance(d, dict):
            return None
        return cls(
            contains_secret=d.get("containsSecret") if isinstance(d.get("containsSecret"), bool) else None,
            redacted_text=d.get("redactedText") if isinstance(d.get("redactedText"), str) else None,
            looks_like_instruction=(
                d.get("looksLikeInstruction") if isinstance(d.get("looksLikeInstruction"), bool) else None
            ),
        )


@dataclass(frozen=True)
class Fact:
    """One stored claim about the user (TS ``UserFact``)."""

    text: str
    extracted_at: str
    source_turn: str
    durable: bool
    source: str = "user_asserted"
    confidence: str | None = None
    category: str | None = None
    project: str | None = None
    key: str | None = None
    supersedes: str | None = None
    retired_at: str | None = None
    injected_count: int | None = None
    last_injected_at: str | None = None
    origin: str | None = None
    evidence: str | None = None
    flagged: bool | None = None
    judgement: CandidateJudgement | None = field(default=None, compare=False)

    @property
    def fact_id(self) -> str:
        return fact_id(self)

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for f in fields(self):
            if f.name == "judgement":
                continue
            v = getattr(self, f.name)
            if v is not None:
                out[_camel(f.name)] = v
        return out

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Fact:
        """Read a wire fact, applying ``migrate_fact`` semantics (missing source -> user_asserted)."""
        kwargs: dict[str, Any] = {}
        for f in fields(cls):
            if f.name == "judgement":
                continue
            v = d.get(_camel(f.name))
            if v is not None:
                kwargs[f.name] = v
        kwargs.setdefault("text", "")
        kwargs.setdefault("extracted_at", "")
        kwargs.setdefault("source_turn", "")
        kwargs["durable"] = bool(kwargs.get("durable", False))
        if not kwargs.get("source"):
            kwargs["source"] = "user_asserted"
        return cls(**kwargs)


# A Candidate is a Fact that may still carry its transient judgement.
Candidate = Fact


def migrate_fact(fact: Fact) -> Fact:
    """A fact with no source reads back as ``user_asserted``; an already-durable fact is never demoted."""
    return fact if fact.source else replace(fact, source="user_asserted")


def fact_id(f: Fact) -> str:
    """The M1 id convention: ``text|extractedAt``."""
    return f"{f.text}|{f.extracted_at}"


def same_fact(a: Fact, b: Fact) -> bool:
    return a.text == b.text and a.extracted_at == b.extracted_at


@dataclass(frozen=True)
class PendingFact(Fact):
    """A fact in the pending-confirmation store. ``category`` is forced to ``other`` when absent."""

    previously_rejected: bool | None = None
    proposed_op: str | None = None
    retire_target_id: str | None = None
    staged_by: str | None = None
    verification: str | None = None

    @classmethod
    def from_fact(cls, f: Fact, **extra: Any) -> PendingFact:
        base = {x.name: getattr(f, x.name) for x in fields(Fact) if x.name != "judgement"}
        if not base.get("category"):
            base["category"] = "other"
        base.update(extra)
        return cls(**base)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> PendingFact:  # type: ignore[override]
        f = Fact.from_dict(d)
        extra = {
            x.name: d[_camel(x.name)]
            for x in fields(cls)
            if x.name not in {y.name for y in fields(Fact)} and d.get(_camel(x.name)) is not None
        }
        return cls.from_fact(f, **extra)


@dataclass(frozen=True)
class RejectedFact:
    text: str
    rejected_at: str
    rejection_source: str  # 'auto_retracted' | 'user_explicit'

    def to_dict(self) -> dict[str, Any]:
        return {"text": self.text, "rejectedAt": self.rejected_at, "rejectionSource": self.rejection_source}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> RejectedFact:
        return cls(
            text=d.get("text", ""),
            rejected_at=d.get("rejectedAt", ""),
            rejection_source=d.get("rejectionSource", "user_explicit"),
        )


@dataclass(frozen=True)
class AuditEntry:
    seq: int
    at: str
    op: str
    fact_id: str
    store: str
    writer: str
    turn: str
    before: Fact | None = None
    after: Fact | None = None
    undoes: int | None = None
    erased: bool | None = None  # deferred: read and preserved, never written
    group: str | None = None  # deferred: read and preserved, never written
    index: int | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for f in fields(self):
            v = getattr(self, f.name)
            if v is None:
                continue
            out[_camel(f.name)] = v.to_dict() if isinstance(v, Fact) else v
        return out

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> AuditEntry:
        kwargs: dict[str, Any] = {}
        for f in fields(cls):
            v = d.get(_camel(f.name))
            if v is None:
                continue
            if f.name in ("before", "after"):
                # A pending pre-image keeps its pending-only fields so undo restores it exactly.
                v = PendingFact.from_dict(v) if d.get("store") == "pending" else Fact.from_dict(v)
            kwargs[f.name] = v
        return cls(**kwargs)


@dataclass(frozen=True)
class AuditDraft:
    """An audit entry before ``seq``/``at`` are assigned (the caller supplies the clock)."""

    op: str
    fact_id: str
    store: str
    writer: str
    turn: str
    before: Fact | None = None
    after: Fact | None = None
    undoes: int | None = None
    index: int | None = None


__all__ = [
    "AuditDraft",
    "AuditEntry",
    "Candidate",
    "CandidateJudgement",
    "Fact",
    "PendingFact",
    "RejectedFact",
    "fact_id",
    "migrate_fact",
    "same_fact",
]
