"""AgentMemoryService: the async Python port of the TS ``MemoryService`` M1/M2/M6 write path.

Owner scoped, storage-agnostic (any ``MemoryStore``), with the clock, the extractor and the judge
injected: the service never reads the wall clock and never decides anything semantic. A candidate
goes gate -> route -> durable / pending / session; a keyed fact supersedes the live one with the
same key into the retired store; every durable/pending change is an audit entry that can be undone
exactly; rendering is budgeted and usage counters are written lazily.

Single-writer rule: ``_commit_durable`` is the ONLY function that writes the durable list, and it
always appends its audit entries in the same call.  Every public mutating method runs inside
``store.transaction(owner)``, so a failure part-way leaves no partial write and two racing
writers for one owner are serialised.

Deliberately not ported (see the M8 scoping addendum): corroboration and the entry/promotion-time
contradiction checks (semantic model calls with no M7 evidence), the legacy 20-fact cap, episodic
digests, the reviewer and consolidation.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field, fields, replace
from typing import Any

from ._core_generated import AUDIT_LOG_KEEP, DEFAULT_MEMORY_BUDGET_CHARS, STORE_KEYS
from .audit import UndoSnapshot, append_audit, plan_undo
from .gate import Judge, admit_with_judge, exclude_injected_block
from .model import AuditDraft, AuditEntry, Candidate, Fact, PendingFact, RejectedFact, fact_id, same_fact
from .render import in_scope, merge_facts, render_facts_block
from .routing import IN_TURN, resolve_write_mode, resolve_write_route
from .store import Clock, Extractor, MemoryStore

DURABLE = STORE_KEYS["durable"]
PENDING = STORE_KEYS["pending"]
REJECTED = STORE_KEYS["rejected"]
RETIRED = STORE_KEYS["retired"]
AUDIT = STORE_KEYS["audit"]
CONSOLIDATION_STATE = STORE_KEYS["consolidation_state"]
OFF = STORE_KEYS["off"]
SESSION_PREFIX = STORE_KEYS["session_facts_prefix"]

_TRUE = {"1", "true", "on", "yes", "enabled"}


def _flag(env: Mapping[str, str], name: str, default: bool) -> bool:
    raw = env.get(name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in _TRUE


@dataclass(frozen=True)
class MemoryFlags:
    """Feature flags, read once from the environment in this one place. Defaults match TS (both OFF)."""

    write_gate: bool = False
    audit_log: bool = False

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> MemoryFlags:
        e = os.environ if env is None else env
        return cls(
            write_gate=_flag(e, "AUDIT_MEMORY_WRITE_GATE", False),
            audit_log=_flag(e, "AUDIT_MEMORY_AUDIT_LOG", False),
        )


@dataclass(frozen=True)
class RoutedFact:
    route: str  # 'durable' | 'pending' | 'session' | 'dropped' | 'skipped'
    fact: Fact | None = None


@dataclass(frozen=True)
class RecordResult:
    outcomes: list[RoutedFact] = field(default_factory=list)
    blocked: bool = False  # /memory off

    def count(self, route: str) -> int:
        return sum(1 for o in self.outcomes if o.route == route)


@dataclass(frozen=True)
class LoadedFacts:
    facts: list[Fact]
    facts_block: str
    dropped_count: int


@dataclass(frozen=True)
class UndoResult:
    ok: bool
    message: str


_PENDING_ONLY = {"previously_rejected", "proposed_op", "retire_target_id", "staged_by", "verification"}
_FACT_FIELDS = [f.name for f in fields(Fact) if f.name != "judgement"]


def _as_fact(p: Fact) -> Fact:
    """A plain Fact copy (drops pending-only fields)."""
    return Fact(**{n: getattr(p, n) for n in _FACT_FIELDS})


def _same_key(f: Fact, key: str | None, project: str | None) -> bool:
    return f.key == key and (f.project or "") == (project or "")


class AgentMemoryService:
    def __init__(
        self,
        store: MemoryStore,
        owner_id: str,
        *,
        clock: Clock,
        flags: MemoryFlags | None = None,
        budget_chars: int = DEFAULT_MEMORY_BUDGET_CHARS,
        write_mode: str = "staged",
        project: str | None = None,
        extractor: Extractor | None = None,
        judge: Judge | None = None,
        audit_keep: int = AUDIT_LOG_KEEP,
    ) -> None:
        if not owner_id:
            raise ValueError("owner_id is required")
        self._store = store
        self.owner_id = owner_id
        self._clock = clock
        self.flags = flags if flags is not None else MemoryFlags.from_env()
        self.budget_chars = budget_chars
        self.write_mode = resolve_write_mode(write_mode)
        self.project = project
        self._extractor = extractor
        self._judge = judge
        self._audit_keep = audit_keep
        self._pending_injections: dict[str, int] = {}
        self.last_injected_block = ""
        self.last_dropped_count = 0

    # ------------------------------------------------------------------ store helpers

    def _session_key(self, session_id: str) -> str:
        return f"{SESSION_PREFIX}{session_id}"

    async def _facts(self, key: str) -> list[Fact]:
        return [Fact.from_dict(d) for d in (await self._store.get_list(self.owner_id, key)) or []]

    async def _set_facts(self, key: str, items: list[Fact]) -> None:
        await self._store.set_list(self.owner_id, key, [f.to_dict() for f in items])

    async def _pending(self) -> list[PendingFact]:
        return [PendingFact.from_dict(d) for d in (await self._store.get_list(self.owner_id, PENDING)) or []]

    async def _rejected(self) -> list[RejectedFact]:
        return [RejectedFact.from_dict(d) for d in (await self._store.get_list(self.owner_id, REJECTED)) or []]

    async def _audit_log(self) -> list[AuditEntry]:
        return [AuditEntry.from_dict(d) for d in (await self._store.get_list(self.owner_id, AUDIT)) or []]

    async def _commit_durable(self, nxt: list[Fact], drafts: list[AuditDraft] | None = None) -> None:
        """The ONLY writer of the durable list. Every add/replace/retire/remove/confirm/usage flush lands here."""
        await self._set_facts(DURABLE, nxt)
        await self._append_audit(drafts or [])

    async def _append_audit(self, drafts: list[AuditDraft]) -> None:
        if not drafts or not self.flags.audit_log:
            return
        log = await self._audit_log()
        state = await self._store.get_state(self.owner_id, CONSOLIDATION_STATE)
        raw = (state or {}).get("lastSeq", 0)
        watermark = raw if isinstance(raw, int) and not isinstance(raw, bool) else 0
        nxt = append_audit(log, drafts, self._clock(), keep=self._audit_keep, watermark=watermark)
        await self._store.set_list(self.owner_id, AUDIT, [e.to_dict() for e in nxt])

    # ------------------------------------------------------------------ /memory off

    async def is_off(self) -> bool:
        state = await self._store.get_state(self.owner_id, OFF)
        return bool(state) and state.get("off") is True

    async def set_off(self, off: bool) -> None:
        await self._store.set_state(self.owner_id, OFF, {"off": off, "at": self._clock()})

    # ------------------------------------------------------------------ read path

    async def load_facts(self, session_id: str, record: bool = True) -> LoadedFacts:
        """Durable + session facts and the budgeted block.  Read-only: usage is collected, not written.

        ``record=False`` is for read-only views: it neither counts as the model having seen the
        facts nor replaces what the last turn injected.
        """
        session = await self._facts(self._session_key(session_id))
        durable = await self._facts(DURABLE)
        facts = merge_facts(durable, session)
        rendered = render_facts_block(in_scope(facts, self.project), self.budget_chars)
        if record:
            self.last_dropped_count = rendered.dropped_count
            self.last_injected_block = rendered.block
            for f in rendered.shown:
                self._pending_injections[fact_id(f)] = self._pending_injections.get(fact_id(f), 0) + 1
        return LoadedFacts(facts, rendered.block, rendered.dropped_count)

    async def flush_usage(self, session_id: str) -> None:
        """The only usage write: apply ``injectedCount``/``lastInjectedAt`` collected by renders."""
        if not self._pending_injections:
            return
        async with self._store.transaction(self.owner_id):
            await self._flush_usage(session_id)

    async def _flush_usage(self, session_id: str) -> None:
        if not self._pending_injections:
            return
        pending, self._pending_injections = self._pending_injections, {}
        now = self._clock()

        def apply(items: list[Fact]) -> tuple[list[Fact], bool]:
            changed = False
            out: list[Fact] = []
            for f in items:
                n = pending.get(fact_id(f))
                if not n:
                    out.append(f)
                    continue
                changed = True
                out.append(replace(f, injected_count=(f.injected_count or 0) + n, last_injected_at=now))
            return out, changed

        try:
            session, s_changed = apply(await self._facts(self._session_key(session_id)))
            if s_changed:
                await self._set_facts(self._session_key(session_id), session)
            durable, d_changed = apply(await self._facts(DURABLE))
            if d_changed:
                await self._commit_durable(durable)
        except BaseException:
            for k, v in pending.items():  # nothing was written; keep the counts for the next flush
                self._pending_injections[k] = self._pending_injections.get(k, 0) + v
            raise

    # ------------------------------------------------------------------ write path

    async def record_message(self, session_id: str, text: str) -> RecordResult:
        """Extract candidates from ``text`` with the injected extractor, then ``record_facts``.

        The previously injected memory block is removed verbatim first (feedback-loop rule).
        """
        if self._extractor is None:
            raise RuntimeError("no extractor configured")
        if await self.is_off():
            return RecordResult(blocked=True)
        cleaned = exclude_injected_block(text, self.last_injected_block)
        try:
            candidates = await self._extractor(cleaned)
        except Exception:
            candidates = []
        return await self.record_facts(session_id, candidates)

    def _stamp(self, c: Candidate, session_id: str) -> Candidate:
        return replace(
            c,
            extracted_at=c.extracted_at or self._clock(),
            source_turn=c.source_turn or f"turn:{session_id}",
        )

    async def record_facts(
        self,
        session_id: str,
        candidates: list[Candidate],
        writer: str = IN_TURN,
        turn: str | None = None,
    ) -> RecordResult:
        """Candidate -> gate -> route -> durable / pending / session, in one transaction."""
        turn = turn or session_id
        async with self._store.transaction(self.owner_id):
            if await self.is_off():
                return RecordResult(blocked=True)
            if writer != IN_TURN:
                outcomes = [await self._submit(writer, c, session_id, turn) for c in candidates]
                return RecordResult(outcomes)
            return await self._record_in_turn(session_id, candidates, turn)

    async def submit_candidate(
        self,
        writer: str,
        candidate: Candidate,
        session_id: str,
        *,
        pending_extras: Mapping[str, Any] | None = None,
        force_gate: bool = False,
    ) -> RoutedFact:
        """Cross-turn writers' single entry point (add-only): off -> gate -> route -> write."""
        async with self._store.transaction(self.owner_id):
            if await self.is_off():
                return RoutedFact("blocked")
            return await self._submit(writer, candidate, session_id, session_id, pending_extras, force_gate)

    async def _submit(
        self,
        writer: str,
        candidate: Candidate,
        session_id: str,
        turn: str,
        pending_extras: Mapping[str, Any] | None = None,
        force_gate: bool = False,
    ) -> RoutedFact:
        candidate = self._stamp(candidate, session_id)
        decision = await admit_with_judge(candidate, force_gate or self.flags.write_gate, self._judge)
        if decision.action == "drop":
            return RoutedFact("dropped")
        fact = decision.fact
        if decision.action == "flag":
            route = "pending"
        elif decision.action == "session":
            route = "session"
        else:
            route = resolve_write_route(self.write_mode, writer, fact)
        if route == "durable":
            durable = await self._facts(DURABLE)
            await self._commit_durable(
                [*durable, fact],
                [AuditDraft("add", fact_id(fact), "durable", writer, turn, after=fact)],
            )
        elif route == "pending":
            pending = await self._pending()
            queued = PendingFact.from_fact(fact, **dict(pending_extras or {}))
            await self._store.set_list(self.owner_id, PENDING, [p.to_dict() for p in [*pending, queued]])
            await self._append_audit([AuditDraft("add", fact_id(fact), "pending", writer, turn, after=queued)])
        else:
            key = self._session_key(session_id)
            session = await self._facts(key)
            await self._set_facts(key, [*session, replace(fact, durable=False)])
        return RoutedFact(route, fact)

    async def _record_in_turn(self, session_id: str, candidates: list[Candidate], turn: str) -> RecordResult:
        mode = self.write_mode
        flagged: list[Fact] = []
        new_facts: list[Fact] = []
        outcomes: list[RoutedFact] = []
        for c in candidates:
            c = self._stamp(c, session_id)
            decision = await admit_with_judge(c, self.flags.write_gate, self._judge)
            if decision.action == "drop":
                outcomes.append(RoutedFact("dropped"))
                continue
            f = decision.fact
            if f.category == "project" and self.project:
                f = replace(f, project=self.project)
            (flagged if decision.action == "flag" else new_facts).append(f)
        await self._flush_usage(session_id)
        if not new_facts and not flagged:
            return RecordResult(outcomes)

        skey = self._session_key(session_id)
        session = await self._facts(skey)
        durable = await self._facts(DURABLE)
        durable_orig = list(durable)
        pending = await self._pending()
        audits: list[AuditDraft] = []
        audits_pending: list[AuditDraft] = []
        retired_now: list[Fact] = []
        durable_changed = False
        pending_changed = False

        def idx_of(f: Fact) -> int | None:
            return next((i for i, d in enumerate(durable_orig) if same_fact(d, f)), None)

        for fact in new_facts:
            route = resolve_write_route(mode, IN_TURN, fact)
            # A candidate that must wait for the user never retires what is stored: the old value stays live.
            if fact.key and route != "pending":
                prior = [f for f in [*durable, *session] if _same_key(f, fact.key, fact.project)]
                if any(f.text == fact.text for f in prior):
                    outcomes.append(RoutedFact("skipped", fact))  # restating the same value is a no-op
                    continue
                if prior:
                    retired_at = self._clock()
                    seen: set[str] = set()
                    for i, old in enumerate(prior):
                        oid = fact_id(old)
                        if oid in seen:
                            continue
                        seen.add(oid)
                        retired_now.append(replace(old, retired_at=retired_at))
                        if any(same_fact(d, old) for d in durable):
                            last = i == len(prior) - 1
                            audits.append(
                                AuditDraft(
                                    "replace" if last else "retire",
                                    oid,
                                    "durable",
                                    "recordFacts:supersede",
                                    turn,
                                    before=old,
                                    after=replace(fact, supersedes=old.text) if last else None,
                                    index=idx_of(old),
                                )
                            )
                    if any(_same_key(f, fact.key, fact.project) for f in durable):
                        durable = [f for f in durable if not _same_key(f, fact.key, fact.project)]
                        durable_changed = True
                    session = [f for f in session if not _same_key(f, fact.key, fact.project)]
                    fact = replace(fact, supersedes=prior[-1].text)
            held = route == "pending" and fact.confidence == "high"
            session = [*session, replace(fact, confidence="medium") if held else fact]
            if route == "durable":
                durable = [*durable, fact]
                durable_changed = True
                if not any(a.op == "replace" and a.after is not None and same_fact(a.after, fact) for a in audits):
                    audits.append(AuditDraft("add", fact_id(fact), "durable", "recordFacts", turn, after=fact))
            elif route == "pending":
                queued = PendingFact.from_fact(replace(fact, confidence="medium") if held else fact)
                pending = [*pending, queued]
                pending_changed = True
                audits_pending.append(AuditDraft("add", fact_id(fact), "pending", "recordFacts", turn, after=queued))
            outcomes.append(RoutedFact(route, fact))
        # An instruction-shaped candidate never auto-promotes and never enters the session store.
        for fact in flagged:
            queued = PendingFact.from_fact(fact)
            pending = [*pending, queued]
            pending_changed = True
            audits_pending.append(
                AuditDraft("add", fact_id(fact), "pending", "recordFacts:flagged", turn, after=queued)
            )
            outcomes.append(RoutedFact("pending", fact))

        if retired_now:
            await self._set_facts(RETIRED, [*await self._facts(RETIRED), *retired_now])
        await self._set_facts(skey, session)
        if durable_changed:
            await self._commit_durable(durable, audits)
        if pending_changed:
            await self._store.set_list(self.owner_id, PENDING, [p.to_dict() for p in pending])
        await self._append_audit(audits_pending)
        return RecordResult(outcomes)

    # ------------------------------------------------------------------ user actions

    async def forget_fact(self, index: int, session_id: str) -> Fact | None:
        """Remove the nth fact of the merged durable-first list (0-based) from every store holding it."""
        async with self._store.transaction(self.owner_id):
            skey = self._session_key(session_id)
            session = await self._facts(skey)
            durable = await self._facts(DURABLE)
            merged = merge_facts(durable, session)
            if index < 0 or index >= len(merged):
                return None
            fact = merged[index]
            rem_durable = [f for f in durable if not same_fact(f, fact)]
            rem_session = [f for f in session if not same_fact(f, fact)]
            if len(rem_durable) != len(durable):
                pos = next(i for i, f in enumerate(durable) if same_fact(f, fact))
                await self._commit_durable(
                    rem_durable,
                    [AuditDraft("remove", fact_id(fact), "durable", "forget", session_id, before=fact, index=pos)],
                )
            if len(rem_session) != len(session):
                await self._set_facts(skey, rem_session)
            return fact

    async def confirm_pending(self, index: int, session_id: str = "memory") -> Fact | None:
        """Promote the nth pending entry (0-based) to durable (keyed supersession applies)."""
        async with self._store.transaction(self.owner_id):
            pending = await self._pending()
            if index < 0 or index >= len(pending):
                return None
            fact = pending[index]
            await self._store.set_list(
                self.owner_id, PENDING, [p.to_dict() for i, p in enumerate(pending) if i != index]
            )
            return await self._promote(fact)

    async def _promote(self, fact: PendingFact) -> Fact:
        durable = await self._facts(DURABLE)
        base = _as_fact(fact)
        if fact.proposed_op == "retire":
            target = next((f for f in durable if fact_id(f) == fact.retire_target_id), None)
            if target is not None:
                retired = await self._facts(RETIRED)
                await self._set_facts(RETIRED, [*retired, replace(target, retired_at=self._clock())])
                await self._commit_durable(
                    [f for f in durable if f is not target],
                    [
                        AuditDraft(
                            "retire",
                            fact_id(target),
                            "durable",
                            "confirm:reviewer-retire",
                            "memory",
                            before=target,
                            index=durable.index(target),
                        )
                    ],
                )
            return replace(base, source="externally_verified", confidence=None, flagged=None)
        confirmed = replace(base, source="externally_verified", confidence=None, flagged=None)
        nxt = list(durable)
        extra: list[AuditDraft] = []
        if confirmed.key:
            priors = [f for f in durable if _same_key(f, confirmed.key, confirmed.project)]
            if priors:
                retired_at = self._clock()
                retired = await self._facts(RETIRED)
                await self._set_facts(RETIRED, [*retired, *(replace(p, retired_at=retired_at) for p in priors)])
                nxt = [f for f in durable if not _same_key(f, confirmed.key, confirmed.project)]
                for p in priors:
                    extra.append(
                        AuditDraft(
                            "retire",
                            fact_id(p),
                            "durable",
                            "confirm:supersede",
                            "memory",
                            before=p,
                            index=durable.index(p),
                        )
                    )
                confirmed = replace(confirmed, supersedes=priors[-1].text)
        await self._commit_durable(
            [*nxt, confirmed],
            [
                *extra,
                AuditDraft("confirm", fact_id(fact), "durable", "confirm", "memory", before=fact, after=confirmed),
            ],
        )
        return confirmed

    async def reject_pending(self, index: int) -> PendingFact | None:
        """Remove the nth pending entry (0-based) into the rejected store (``user_explicit``)."""
        async with self._store.transaction(self.owner_id):
            pending = await self._pending()
            if index < 0 or index >= len(pending):
                return None
            fact = pending[index]
            await self._store.set_list(
                self.owner_id, PENDING, [p.to_dict() for i, p in enumerate(pending) if i != index]
            )
            rejected = await self._rejected()
            nxt = [*rejected, RejectedFact(fact.text, self._clock(), "user_explicit")]
            await self._store.set_list(self.owner_id, REJECTED, [r.to_dict() for r in nxt])
            await self._append_audit(
                [AuditDraft("reject", fact_id(fact), "pending", "reject:user_explicit", "memory", before=fact)]
            )
            return fact

    # ------------------------------------------------------------------ audit / undo

    async def get_audit_log(self, limit: int = 20) -> list[AuditEntry]:
        """Newest last; the last ``limit`` entries."""
        log = await self._audit_log()
        return log[-limit:] if limit > 0 else []

    async def undo_audit(self, seq: int, session_id: str = "undo") -> UndoResult:
        """Restore one audit entry's pre-image exactly and append an ``undo`` entry."""
        async with self._store.transaction(self.owner_id):
            log = await self._audit_log()
            snap = UndoSnapshot(
                durable=await self._facts(DURABLE),
                pending=await self._pending_or_none(),
                retired=await self._opt_facts(RETIRED),
                rejected=await self._rejected_or_none(),
            )
            plan = plan_undo(log, seq, snap, session_id)
            if not plan.ok:
                return UndoResult(False, plan.message)
            entry = next(e for e in log if e.seq == seq)
            if plan.pending is not None:
                await self._store.set_list(self.owner_id, PENDING, [p.to_dict() for p in plan.pending])
            if plan.rejected is not None:
                await self._store.set_list(self.owner_id, REJECTED, [r.to_dict() for r in plan.rejected])
            if plan.retired is not None:
                await self._set_facts(RETIRED, plan.retired)
            elif plan.retired_absent:
                await self._store.delete(self.owner_id, RETIRED)
            drafts = [plan.draft] if plan.draft is not None else []
            if entry.store == "durable" and plan.durable is not None:
                await self._commit_durable(plan.durable, drafts)
            else:
                await self._append_audit(drafts)
            return UndoResult(True, plan.message)

    async def _opt_facts(self, key: str) -> list[Fact] | None:
        raw = await self._store.get_list(self.owner_id, key)
        return None if raw is None else [Fact.from_dict(d) for d in raw]

    async def _pending_or_none(self) -> list[Fact] | None:
        raw = await self._store.get_list(self.owner_id, PENDING)
        return None if raw is None else [PendingFact.from_dict(d) for d in raw]

    async def _rejected_or_none(self) -> list[RejectedFact] | None:
        raw = await self._store.get_list(self.owner_id, REJECTED)
        return None if raw is None else [RejectedFact.from_dict(d) for d in raw]

    # ------------------------------------------------------------------ read-only views

    async def list_durable(self) -> list[Fact]:
        return await self._facts(DURABLE)

    async def list_pending(self) -> list[PendingFact]:
        return await self._pending()

    async def list_rejected(self) -> list[RejectedFact]:
        return await self._rejected()

    async def list_retired(self) -> list[Fact]:
        return await self._facts(RETIRED)


__all__ = [
    "AgentMemoryService",
    "LoadedFacts",
    "MemoryFlags",
    "RecordResult",
    "RoutedFact",
    "UndoResult",
]
