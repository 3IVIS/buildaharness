"""
Flow CRUD + versioning.

GET    /flows                                    → list user's flows
POST   /flows                                    → upsert + auto-version
GET    /flows/{id}                               → current spec
DELETE /flows/{id}                               → delete flow + versions
GET    /flows/{id}/versions                      → version history (newest first)
GET    /flows/{id}/versions/{ver_id}             → specific version spec
POST   /flows/{id}/versions/{ver_id}/restore     → restore as new current
"""
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db import Flow, FlowVersion, User, get_session, next_version_num
from auth import current_user
# Fix circular import: was `from main import _validate_spec` which caused
# flows_api -> main -> flows_api ImportError at startup.
from validate import validate_spec as _validate_spec

router  = APIRouter(prefix="/flows", tags=["flows"])
AuthDep = Annotated[User,         Depends(current_user)]
DbDep   = Annotated[AsyncSession, Depends(get_session)]


# ── Schemas ───────────────────────────────────────────────────────────────────

class FlowSummary(BaseModel):
    id:         str
    name:       str
    updated_at: datetime
    created_at: datetime

class VersionSummary(BaseModel):
    id:          str
    version_num: int
    label:       str | None
    created_at:  datetime

class SaveFlowRequest(BaseModel):
    spec: dict

class SaveFlowResponse(BaseModel):
    id:          str
    version_num: int


# ── Helpers ───────────────────────────────────────────────────────────────────

async def _get_flow(flow_id: str, user: User, db: AsyncSession) -> Flow:
    flow = await db.get(Flow, flow_id)
    if not flow or str(flow.user_id) != str(user.id):
        raise HTTPException(status_code=404, detail="Flow not found")
    return flow


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("", response_model=list[FlowSummary])
async def list_flows(
    user:   AuthDep,
    db:     DbDep,
    limit:  int = Query(default=50, ge=1, le=200, description="Max flows to return"),
    offset: int = Query(default=0,  ge=0,          description="Pagination offset"),
):
    """Fix #20: paginated list — default 50, max 200 per page."""
    rows = (await db.execute(
        select(Flow)
        .where(Flow.user_id == user.id)
        .order_by(Flow.updated_at.desc())
        .limit(limit)
        .offset(offset)
    )).scalars().all()
    return [FlowSummary(id=f.id, name=f.name,
                        updated_at=f.updated_at, created_at=f.created_at) for f in rows]


@router.post("", response_model=SaveFlowResponse, status_code=200)
async def save_flow(req: SaveFlowRequest, user: AuthDep, db: DbDep):
    spec    = req.spec
    flow_id = spec.get("id")
    name    = spec.get("name") or flow_id or "Untitled"
    if not flow_id:
        raise HTTPException(status_code=400, detail="spec.id is required")

    # Fix #7: validate structure before writing to Postgres.  Previously any JSON
    # dict with an 'id' key was accepted and stored; corrupt/malicious specs were
    # only caught later at compile or run time, producing confusing errors.
    _validate_spec(spec)

    flow = await db.get(Flow, flow_id)
    if flow:
        if str(flow.user_id) != str(user.id):
            raise HTTPException(status_code=403, detail="Flow belongs to another user")
        flow.name         = name
        flow.current_spec = spec
        flow.updated_at   = datetime.now(timezone.utc)
    else:
        flow = Flow(id=flow_id, user_id=user.id, name=name, current_spec=spec)
        db.add(flow)
        await db.flush()

    ver_num = await next_version_num(flow_id, db)
    db.add(FlowVersion(flow_id=flow_id, user_id=user.id, spec=spec, version_num=ver_num))
    await db.commit()

    return SaveFlowResponse(id=flow_id, version_num=ver_num)


@router.get("/{flow_id}", response_model=dict)
async def get_flow(flow_id: str, user: AuthDep, db: DbDep):
    flow = await _get_flow(flow_id, user, db)
    return flow.current_spec


@router.delete("/{flow_id}", status_code=204)
async def delete_flow(flow_id: str, user: AuthDep, db: DbDep):
    flow = await _get_flow(flow_id, user, db)
    await db.delete(flow)
    await db.commit()


@router.get("/{flow_id}/versions", response_model=list[VersionSummary])
async def list_versions(
    flow_id: str,
    user:    AuthDep,
    db:      DbDep,
    limit:   int = Query(default=50, ge=1, le=200, description="Max versions to return"),
    offset:  int = Query(default=0,  ge=0,          description="Pagination offset"),
):
    """Fix #18: paginated version list — default 50, max 200 per page."""
    await _get_flow(flow_id, user, db)
    rows = (await db.execute(
        select(FlowVersion)
        .where(FlowVersion.flow_id == flow_id)
        .order_by(FlowVersion.version_num.desc())
        .limit(limit)
        .offset(offset)
    )).scalars().all()
    return [VersionSummary(id=str(v.id), version_num=v.version_num,
                           label=v.label, created_at=v.created_at) for v in rows]


@router.get("/{flow_id}/versions/{version_id}", response_model=dict)
async def get_version(flow_id: str, version_id: str, user: AuthDep, db: DbDep):
    await _get_flow(flow_id, user, db)
    ver = (await db.execute(
        select(FlowVersion).where(FlowVersion.flow_id == flow_id,
                                  FlowVersion.id      == version_id)
    )).scalar_one_or_none()
    if not ver:
        raise HTTPException(status_code=404, detail="Version not found")
    return ver.spec


@router.post("/{flow_id}/versions/{version_id}/restore", response_model=SaveFlowResponse)
async def restore_version(flow_id: str, version_id: str, user: AuthDep, db: DbDep):
    flow = await _get_flow(flow_id, user, db)
    ver  = (await db.execute(
        select(FlowVersion).where(FlowVersion.flow_id == flow_id,
                                  FlowVersion.id      == version_id)
    )).scalar_one_or_none()
    if not ver:
        raise HTTPException(status_code=404, detail="Version not found")

    restored_spec = ver.spec
    flow.current_spec = restored_spec
    # Also restore the flow name from the spec so the library panel shows the
    # correct name after restore (previously flow.name kept the most recent name,
    # which could differ from the restored version's name).
    flow.name         = restored_spec.get("name") or flow.name
    flow.updated_at   = datetime.now(timezone.utc)

    ver_num = await next_version_num(flow_id, db)
    db.add(FlowVersion(flow_id=flow_id, user_id=user.id, spec=restored_spec,
                       version_num=ver_num, label=f"Restored from v{ver.version_num}"))
    await db.commit()
    return SaveFlowResponse(id=flow_id, version_num=ver_num)
