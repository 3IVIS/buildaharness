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

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from auth import current_user
from db import Flow, FlowVersion, User, get_session, next_version_num
from org_context import Org, OrgDep
from rate_limit import limiter
from validate import validate_spec as _validate_spec

router = APIRouter(prefix="/flows", tags=["flows"])
AuthDep = Annotated[User, Depends(current_user)]
DbDep = Annotated[AsyncSession, Depends(get_session)]


# ── Schemas ───────────────────────────────────────────────────────────────────


class FlowSummary(BaseModel):
    id: str
    name: str
    updated_at: datetime
    created_at: datetime


class VersionSummary(BaseModel):
    id: str
    version_num: int
    label: str | None
    created_at: datetime


class SaveFlowRequest(BaseModel):
    spec: dict


class SaveFlowResponse(BaseModel):
    id: str
    version_num: int


# ── Helpers ───────────────────────────────────────────────────────────────────


async def _get_flow(flow_id: str, user: User, db: AsyncSession, org: Org | None = None) -> Flow:
    flow = await db.get(Flow, flow_id)
    if not flow or str(flow.user_id) != str(user.id):
        raise HTTPException(status_code=404, detail="Flow not found")
    # Org isolation: if a org context is provided and the flow has an org_id,
    # they must match.  Flows with no org_id (pre-migration rows) are accessible
    # to the owner regardless of org context.
    if org and flow.org_id and str(flow.org_id) != str(org.id):
        raise HTTPException(status_code=404, detail="Flow not found")
    return flow


# ── Routes ────────────────────────────────────────────────────────────────────


@router.get("", response_model=list[FlowSummary])
async def list_flows(
    user: AuthDep,
    db: DbDep,
    org: OrgDep,
    limit: int = Query(default=50, ge=1, le=200, description="Max flows to return"),
    offset: int = Query(default=0, ge=0, description="Pagination offset"),
):
    """Fix #20: paginated list — default 50, max 200 per page.

    Scoped to the active org: only flows whose org_id matches are returned.
    Flows with no org_id (pre-namespacing rows) are included for the owner.
    """
    from sqlalchemy import or_

    rows = (
        (
            await db.execute(
                select(Flow)
                .where(
                    Flow.user_id == user.id,
                    or_(Flow.org_id == org.id, Flow.org_id.is_(None)),
                )
                .order_by(Flow.updated_at.desc())
                .limit(limit)
                .offset(offset)
            )
        )
        .scalars()
        .all()
    )
    return [FlowSummary(id=f.id, name=f.name, updated_at=f.updated_at, created_at=f.created_at) for f in rows]


@router.post("", response_model=SaveFlowResponse, status_code=200)
@limiter.limit("30/minute")
async def save_flow(request: Request, req: SaveFlowRequest, user: AuthDep, db: DbDep, org: OrgDep):
    spec = req.spec
    flow_id = spec.get("id")
    name = spec.get("name") or flow_id or "Untitled"
    if not flow_id:
        raise HTTPException(status_code=400, detail="spec.id is required")

    _validate_spec(spec)

    flow = await db.get(Flow, flow_id)
    if flow:
        if str(flow.user_id) != str(user.id):
            raise HTTPException(status_code=403, detail="Flow belongs to another user")
        # Org isolation: if the flow is already scoped to an org, the caller
        # must be presenting that same org in context.  Prevent silently moving
        # a flow between orgs or saving into the wrong namespace.
        if flow.org_id and str(flow.org_id) != str(org.id):
            raise HTTPException(status_code=404, detail="Flow not found")
        flow.name = name
        flow.current_spec = spec
        flow.updated_at = datetime.now(UTC)
        # Back-fill org_id for pre-namespacing rows (migration 0005 data
        # migration covers existing rows, but belt-and-suspenders for any
        # row that slipped through with a null org_id).
        if flow.org_id is None:
            flow.org_id = org.id
    else:
        flow = Flow(id=flow_id, user_id=user.id, org_id=org.id, name=name, current_spec=spec)
        db.add(flow)
        await db.flush()

    ver_num = await next_version_num(flow_id, db)
    db.add(FlowVersion(flow_id=flow_id, user_id=user.id, spec=spec, version_num=ver_num))
    await db.commit()

    return SaveFlowResponse(id=flow_id, version_num=ver_num)


@router.get("/{flow_id}", response_model=dict)
@limiter.limit("20/minute")
async def get_flow(request: Request, flow_id: str, user: AuthDep, db: DbDep, org: OrgDep):
    flow = await _get_flow(flow_id, user, db, org)
    return flow.current_spec


@router.delete("/{flow_id}", status_code=204)
@limiter.limit("20/minute")
async def delete_flow(request: Request, flow_id: str, user: AuthDep, db: DbDep, org: OrgDep):
    flow = await _get_flow(flow_id, user, db, org)
    await db.delete(flow)
    await db.commit()


@router.get("/{flow_id}/versions", response_model=list[VersionSummary])
async def list_versions(
    flow_id: str,
    user: AuthDep,
    db: DbDep,
    org: OrgDep,
    limit: int = Query(default=50, ge=1, le=200, description="Max versions to return"),
    offset: int = Query(default=0, ge=0, description="Pagination offset"),
):
    """Fix #18: paginated version list — default 50, max 200 per page."""
    await _get_flow(flow_id, user, db, org)
    rows = (
        (
            await db.execute(
                select(FlowVersion)
                .where(FlowVersion.flow_id == flow_id)
                .order_by(FlowVersion.version_num.desc())
                .limit(limit)
                .offset(offset)
            )
        )
        .scalars()
        .all()
    )
    return [
        VersionSummary(id=str(v.id), version_num=v.version_num, label=v.label, created_at=v.created_at) for v in rows
    ]


@router.get("/{flow_id}/versions/{version_id}", response_model=dict)
async def get_version(flow_id: str, version_id: str, user: AuthDep, db: DbDep, org: OrgDep):
    await _get_flow(flow_id, user, db, org)
    ver = (
        await db.execute(select(FlowVersion).where(FlowVersion.flow_id == flow_id, FlowVersion.id == version_id))
    ).scalar_one_or_none()
    if not ver:
        raise HTTPException(status_code=404, detail="Version not found")
    return ver.spec


@router.post("/{flow_id}/versions/{version_id}/restore", response_model=SaveFlowResponse)
@limiter.limit("10/minute")
async def restore_version(request: Request, flow_id: str, version_id: str, user: AuthDep, db: DbDep, org: OrgDep):
    flow = await _get_flow(flow_id, user, db, org)
    ver = (
        await db.execute(select(FlowVersion).where(FlowVersion.flow_id == flow_id, FlowVersion.id == version_id))
    ).scalar_one_or_none()
    if not ver:
        raise HTTPException(status_code=404, detail="Version not found")

    restored_spec = ver.spec
    flow.current_spec = restored_spec
    flow.name = restored_spec.get("name") or flow.name
    flow.updated_at = datetime.now(UTC)

    ver_num = await next_version_num(flow_id, db)
    db.add(
        FlowVersion(
            flow_id=flow_id,
            user_id=user.id,
            spec=restored_spec,
            version_num=ver_num,
            label=f"Restored from v{ver.version_num}",
        )
    )
    await db.commit()
    return SaveFlowResponse(id=flow_id, version_num=ver_num)
