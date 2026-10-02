"""
Agent memory REST surface (M8 / WP-D) over ``harness.agent_memory.AgentMemoryService``.

GET    /memory/facts                    → durable + session facts (merged, durable first) + dropped count
GET    /memory/render                   → the budgeted facts block exactly as a prompt would receive it
POST   /memory/facts                    → record candidate facts (gated; see below)
DELETE /memory/facts/{index}            → forget the nth fact of the merged list (0-based)
GET    /memory/pending                  → candidates waiting for the user
POST   /memory/pending/{index}/confirm  → promote a pending fact to durable
POST   /memory/pending/{index}/reject   → move a pending fact to the rejected store
GET    /memory/history                  → audit log (newest last)
POST   /memory/history/{seq}/undo       → exact-restore undo of one audit entry
GET    /memory/export                   → every store for the caller, for review/backup
GET    /memory/status                   → off switch state + effective flags
POST   /memory/off | /memory/on         → the memory off switch

Auth + scoping: every route requires a bearer token and resolves the active org exactly as the
sibling routers do (OrgDep). The memory owner id is ``"<org_id>:<user_id>"`` so one user's facts
never leak across users or across orgs; a user in two orgs has two memories.

Safety (structural, not textual): the record endpoint accepts only candidates whose
``source == "user_asserted"`` and whose ``origin`` is absent or ``user``, UNLESS the write gate
(``AUDIT_MEMORY_WRITE_GATE``) is on. Model-inferred or agent/tool/web text can therefore never be
stored unredacted and unflagged through this router. The extractor (``harness.agent_memory.
extractor``) is deliberately NOT wired to any route here.

Not ported from the TS MemoryService (behaviour differs; do not assume parity beyond the shared
contract ``spec/memory-core.json``): corroboration and the entry/promotion-time contradiction
checks, the lexical fact pass, episodic digests, the post-turn reviewer and consolidation. The
audit log is empty unless ``AUDIT_MEMORY_AUDIT_LOG`` is on. Write mode comes from
``AGENT_MEMORY_WRITE_MODE`` (auto|staged|user_only, default staged).
"""

from __future__ import annotations

import os
import weakref
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from auth import current_user
from db import User, get_session
from harness.agent_memory._core_generated import (
    FACT_CATEGORIES,
    FACT_CONFIDENCES,
    FACT_ORIGINS,
    FACT_SOURCES,
    WRITERS,
)
from harness.agent_memory.model import Candidate, CandidateJudgement, Fact
from harness.agent_memory.routing import IN_TURN
from harness.agent_memory.service import AgentMemoryService, MemoryFlags
from harness.agent_memory.store import MemoryStore
from harness.agent_memory.store_sql import SqlMemoryStore
from org_context import OrgDep

router = APIRouter(prefix="/memory", tags=["memory"])

_MAX_CANDIDATES = 50
_MAX_TEXT = 2000

# ── Dependencies ──────────────────────────────────────────────────────────────

_STORES: weakref.WeakKeyDictionary[Any, SqlMemoryStore] = weakref.WeakKeyDictionary()


async def get_memory_store(db: Annotated[AsyncSession, Depends(get_session)]) -> MemoryStore:
    """One SqlMemoryStore per engine (its writer lock must be shared across requests)."""
    engine = db.bind
    store = _STORES.get(engine)
    if store is None:
        store = SqlMemoryStore(engine)  # type: ignore[arg-type]
        _STORES[engine] = store
    return store


def _clock() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def owner_id_for(org: Any, user: User) -> str:
    return f"{org.id}:{user.id}"


async def get_memory_service(
    org: OrgDep,
    user: Annotated[User, Depends(current_user)],
    store: Annotated[MemoryStore, Depends(get_memory_store)],
    project: Annotated[str | None, Query(max_length=200)] = None,
) -> AgentMemoryService:
    return AgentMemoryService(
        store,
        owner_id_for(org, user),
        clock=_clock,
        flags=MemoryFlags.from_env(),
        write_mode=os.getenv("AGENT_MEMORY_WRITE_MODE", ""),
        project=project,
    )


Svc = Annotated[AgentMemoryService, Depends(get_memory_service)]

# ── Schemas ───────────────────────────────────────────────────────────────────


class JudgementIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    containsSecret: bool | None = None
    redactedText: str | None = Field(default=None, max_length=_MAX_TEXT)
    looksLikeInstruction: bool | None = None


class CandidateIn(BaseModel):
    """Client-settable candidate fields only. Timestamps, usage, supersession and flags are server-owned."""

    model_config = ConfigDict(extra="forbid")
    text: str = Field(min_length=1, max_length=_MAX_TEXT)
    durable: bool = False
    source: str = "user_asserted"
    confidence: str | None = None
    category: str | None = None
    key: str | None = Field(default=None, max_length=100)
    project: str | None = Field(default=None, max_length=200)
    origin: str | None = None
    evidence: str | None = Field(default=None, max_length=_MAX_TEXT)
    judgement: JudgementIn | None = None


class RecordRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: str = Field(default="default", min_length=1, max_length=200)
    candidates: list[CandidateIn] = Field(min_length=1, max_length=_MAX_CANDIDATES)
    writer: str = IN_TURN
    turn: str | None = Field(default=None, max_length=200)


def _validate_enum(value: str | None, allowed: list[str], name: str) -> None:
    if value is not None and value not in allowed:
        raise HTTPException(status_code=422, detail=f"invalid {name}: {value!r}")


def _to_candidate(c: CandidateIn) -> Candidate:
    _validate_enum(c.source, FACT_SOURCES, "source")
    _validate_enum(c.confidence, FACT_CONFIDENCES, "confidence")
    _validate_enum(c.category, FACT_CATEGORIES, "category")
    _validate_enum(c.origin, FACT_ORIGINS, "origin")
    j = c.judgement
    return Fact(
        text=c.text,
        extracted_at="",
        source_turn="",
        durable=c.durable,
        source=c.source,
        confidence=c.confidence,
        category=c.category,
        key=c.key,
        project=c.project,
        origin=c.origin,
        evidence=c.evidence,
        judgement=None
        if j is None
        else CandidateJudgement(
            contains_secret=j.containsSecret,
            redacted_text=j.redactedText,
            looks_like_instruction=j.looksLikeInstruction,
        ),
    )


def _is_plain_user_assertion(c: CandidateIn) -> bool:
    return c.source == "user_asserted" and c.origin in (None, "user")


def _facts(items: list[Any]) -> list[dict[str, Any]]:
    return [f.to_dict() for f in items]


# ── Routes ────────────────────────────────────────────────────────────────────

SessionQ = Annotated[str, Query(min_length=1, max_length=200)]


@router.get("/facts")
async def list_facts(svc: Svc, session_id: SessionQ = "default") -> dict[str, Any]:
    loaded = await svc.load_facts(session_id, record=False)
    return {"facts": _facts(loaded.facts), "dropped_count": loaded.dropped_count}


@router.get("/render")
async def render_facts(svc: Svc, session_id: SessionQ = "default") -> dict[str, Any]:
    loaded = await svc.load_facts(session_id, record=False)
    return {
        "facts_block": loaded.facts_block,
        "dropped_count": loaded.dropped_count,
        "budget_chars": svc.budget_chars,
    }


@router.post("/facts")
async def record_facts(req: RecordRequest, svc: Svc) -> dict[str, Any]:
    if req.writer not in WRITERS:
        raise HTTPException(status_code=422, detail=f"invalid writer: {req.writer!r}")
    candidates = [_to_candidate(c) for c in req.candidates]  # validates enums first (422)
    if not svc.flags.write_gate:
        bad = [i for i, c in enumerate(req.candidates) if not _is_plain_user_assertion(c)]
        if bad:
            raise HTTPException(
                status_code=403,
                detail=(
                    "only user_asserted candidates with a user origin are accepted while the memory write gate "
                    f"(AUDIT_MEMORY_WRITE_GATE) is off; rejected candidate indexes: {bad}"
                ),
            )
    result = await svc.record_facts(req.session_id, candidates, writer=req.writer, turn=req.turn)
    return {
        "blocked": result.blocked,
        "outcomes": [{"route": o.route, "fact": o.fact.to_dict() if o.fact else None} for o in result.outcomes],
    }


@router.delete("/facts/{index}")
async def forget_fact(index: int, svc: Svc, session_id: SessionQ = "default") -> dict[str, Any]:
    fact = await svc.forget_fact(index, session_id)
    if fact is None:
        raise HTTPException(status_code=404, detail="No fact at that index")
    return {"forgotten": fact.to_dict()}


@router.get("/pending")
async def list_pending(svc: Svc) -> dict[str, Any]:
    return {"pending": _facts(await svc.list_pending())}


@router.post("/pending/{index}/confirm")
async def confirm_pending(index: int, svc: Svc) -> dict[str, Any]:
    fact = await svc.confirm_pending(index)
    if fact is None:
        raise HTTPException(status_code=404, detail="No pending fact at that index")
    return {"confirmed": fact.to_dict()}


@router.post("/pending/{index}/reject")
async def reject_pending(index: int, svc: Svc) -> dict[str, Any]:
    fact = await svc.reject_pending(index)
    if fact is None:
        raise HTTPException(status_code=404, detail="No pending fact at that index")
    return {"rejected": fact.to_dict()}


@router.get("/history")
async def audit_history(svc: Svc, limit: Annotated[int, Query(ge=1, le=500)] = 20) -> dict[str, Any]:
    entries = await svc.get_audit_log(limit)
    return {"audit_log_enabled": svc.flags.audit_log, "entries": [e.to_dict() for e in entries]}


@router.post("/history/{seq}/undo")
async def undo_audit(seq: int, svc: Svc) -> dict[str, Any]:
    result = await svc.undo_audit(seq)
    return {"ok": result.ok, "message": result.message}


@router.get("/export")
async def export_memory(svc: Svc) -> dict[str, Any]:
    return {
        "durable": _facts(await svc.list_durable()),
        "pending": _facts(await svc.list_pending()),
        "rejected": [r.to_dict() for r in await svc.list_rejected()],
        "retired": _facts(await svc.list_retired()),
        "audit": [e.to_dict() for e in await svc.get_audit_log(10_000)],
    }


@router.get("/status")
async def memory_status(svc: Svc) -> dict[str, Any]:
    return {
        "off": await svc.is_off(),
        "write_gate": svc.flags.write_gate,
        "audit_log": svc.flags.audit_log,
        "write_mode": svc.write_mode,
        "budget_chars": svc.budget_chars,
    }


@router.post("/off")
async def memory_off(svc: Svc) -> dict[str, Any]:
    await svc.set_off(True)
    return {"off": True}


@router.post("/on")
async def memory_on(svc: Svc) -> dict[str, Any]:
    await svc.set_off(False)
    return {"off": False}
