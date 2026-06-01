"""
Team RBAC API — Phase 3

Endpoints
  POST   /teams                              → create team (caller becomes admin)
  GET    /teams                              → list teams the caller belongs to
  GET    /teams/{team_id}                    → team detail + member list
  PATCH  /teams/{team_id}                    → rename team (admin only)
  DELETE /teams/{team_id}                    → delete team (admin only)

  POST   /teams/{team_id}/members            → invite user by email (admin only)
  PATCH  /teams/{team_id}/members/{user_id}  → change role (admin only)
  DELETE /teams/{team_id}/members/{user_id}  → remove member (admin only)

  GET    /teams/{team_id}/flows              → list flows shared with a team
  POST   /teams/{team_id}/flows/{flow_id}    → share a flow with a team (admin only)
  DELETE /teams/{team_id}/flows/{flow_id}    → revoke team access to a flow (admin only)

Role hierarchy (least → most privileged):
    viewer  — can list and compile flows shared with the team
    editor  — can save new versions of shared flows
    admin   — can manage members, rename/delete the team, share/unshare flows

Role enforcement:
    _require_role(team_id_uuid, user, minimum, db) raises 403 when the caller's
    role in the given team is lower than minimum.
"""

import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from auth import current_user
from db import (
    Flow,
    FlowPermission,
    Team,
    TeamMembership,
    TeamRole,
    User,
    get_session,
)
from rate_limit import limiter

router = APIRouter(prefix="/teams", tags=["teams"])
AuthDep = Annotated[User, Depends(current_user)]
DbDep = Annotated[AsyncSession, Depends(get_session)]

_ROLE_RANK = {TeamRole.viewer: 0, TeamRole.editor: 1, TeamRole.admin: 2}


# ── UUID path-param parsing ───────────────────────────────────────────────────


def _parse_team_uuid(team_id: str) -> uuid.UUID:
    try:
        return uuid.UUID(team_id)
    except (ValueError, AttributeError):
        raise HTTPException(status_code=422, detail=f"Invalid team_id: {team_id!r}") from None


def _parse_user_uuid(user_id: str) -> uuid.UUID:
    try:
        return uuid.UUID(user_id)
    except (ValueError, AttributeError):
        raise HTTPException(status_code=422, detail=f"Invalid user_id: {user_id!r}") from None


# ── Pydantic schemas ──────────────────────────────────────────────────────────


class TeamCreate(BaseModel):
    name: str

    @field_validator("name")
    @classmethod
    def name_not_empty(cls, v: str) -> str:
        stripped = v.strip()
        if not stripped:
            raise ValueError("Team name must not be empty")
        return stripped


class TeamRename(BaseModel):
    name: str

    @field_validator("name")
    @classmethod
    def name_not_empty(cls, v: str) -> str:
        stripped = v.strip()
        if not stripped:
            raise ValueError("Team name must not be empty")
        return stripped


class MemberInvite(BaseModel):
    email: EmailStr
    role: Literal["admin", "editor", "viewer"] = "viewer"


class MemberRoleUpdate(BaseModel):
    role: Literal["admin", "editor", "viewer"]


class FlowShareRequest(BaseModel):
    permission: Literal["view", "edit"] = "view"


class MemberOut(BaseModel):
    user_id: str
    email: str
    role: str


class TeamOut(BaseModel):
    id: str
    name: str
    created_by: str | None
    members: list[MemberOut]


class TeamSummary(BaseModel):
    id: str
    name: str
    role: str


class FlowPermissionOut(BaseModel):
    flow_id: str
    team_id: str
    permission: str


class SharedFlowOut(BaseModel):
    flow_id: str
    flow_name: str
    permission: str


# ── Internal helpers ──────────────────────────────────────────────────────────


async def _get_team(tid: uuid.UUID, db: AsyncSession) -> Team:
    team = (
        await db.execute(
            select(Team).where(Team.id == tid).options(selectinload(Team.memberships).selectinload(TeamMembership.user))
        )
    ).scalar_one_or_none()
    if not team:
        raise HTTPException(status_code=404, detail="Team not found")
    return team


async def _get_membership(tid: uuid.UUID, uid: uuid.UUID, db: AsyncSession) -> TeamMembership:
    m = (
        await db.execute(
            select(TeamMembership).where(
                TeamMembership.team_id == tid,
                TeamMembership.user_id == uid,
            )
        )
    ).scalar_one_or_none()
    if not m:
        raise HTTPException(status_code=403, detail="Not a member of this team")
    return m


async def _require_role(
    tid: uuid.UUID,
    user: User,
    minimum: TeamRole,
    db: AsyncSession,
) -> TeamMembership:
    m = await _get_membership(tid, user.id, db)
    if _ROLE_RANK[TeamRole(m.role)] < _ROLE_RANK[minimum]:
        raise HTTPException(
            status_code=403,
            detail=f"Requires {minimum.value} role (you are {m.role})",
        )
    return m


async def _count_admins(tid: uuid.UUID, db: AsyncSession) -> int:
    rows = (
        (
            await db.execute(
                select(TeamMembership).where(
                    TeamMembership.team_id == tid,
                    TeamMembership.role == TeamRole.admin.value,
                )
            )
        )
        .scalars()
        .all()
    )
    return len(rows)


def _team_out(team: Team) -> TeamOut:
    members = [MemberOut(user_id=str(m.user_id), email=m.user.email, role=m.role) for m in team.memberships]
    return TeamOut(
        id=str(team.id),
        name=team.name,
        created_by=str(team.created_by) if team.created_by else None,
        members=members,
    )


# ── Team CRUD ─────────────────────────────────────────────────────────────────


@router.post("", response_model=TeamOut, status_code=201)
@limiter.limit("20/minute")
async def create_team(request: Request, req: TeamCreate, user: AuthDep, db: DbDep):
    """Create a new team. The caller is automatically added as admin."""
    team = Team(name=req.name, created_by=user.id)
    db.add(team)
    await db.flush()
    db.add(TeamMembership(team_id=team.id, user_id=user.id, role=TeamRole.admin.value))
    await db.commit()
    return _team_out(await _get_team(team.id, db))


@router.get("", response_model=list[TeamSummary])
async def list_teams(user: AuthDep, db: DbDep):
    """Return all teams the caller belongs to with their role in each."""
    rows = (
        await db.execute(
            select(TeamMembership, Team)
            .join(Team, Team.id == TeamMembership.team_id)
            .where(TeamMembership.user_id == user.id)
            .order_by(Team.name)
        )
    ).all()
    return [TeamSummary(id=str(team.id), name=team.name, role=membership.role) for membership, team in rows]


@router.get("/{team_id}", response_model=TeamOut)
@limiter.limit("20/minute")
async def get_team(request: Request, team_id: str, user: AuthDep, db: DbDep):
    """Return team detail. Caller must be a member."""
    tid = _parse_team_uuid(team_id)
    await _get_membership(tid, user.id, db)
    return _team_out(await _get_team(tid, db))


@router.patch("/{team_id}", response_model=TeamOut)
@limiter.limit("20/minute")
async def rename_team(request: Request, team_id: str, req: TeamRename, user: AuthDep, db: DbDep):
    """Rename a team. Admin only."""
    tid = _parse_team_uuid(team_id)
    await _require_role(tid, user, TeamRole.admin, db)
    team = await _get_team(tid, db)
    team.name = req.name
    await db.commit()
    return _team_out(await _get_team(tid, db))


@router.delete("/{team_id}", status_code=204)
@limiter.limit("20/minute")
async def delete_team(request: Request, team_id: str, user: AuthDep, db: DbDep):
    """Delete a team and cascade to memberships/permissions. Admin only."""
    tid = _parse_team_uuid(team_id)
    await _require_role(tid, user, TeamRole.admin, db)
    team = await db.get(Team, tid)
    if not team:
        raise HTTPException(status_code=404, detail="Team not found")
    await db.delete(team)
    await db.commit()


# ── Member management ─────────────────────────────────────────────────────────


@router.post("/{team_id}/members", response_model=MemberOut, status_code=201)
@limiter.limit("20/minute")
async def invite_member(request: Request, team_id: str, req: MemberInvite, user: AuthDep, db: DbDep):
    """Add a user by email. Admin only.

    Idempotent: re-inviting an existing member updates their role and returns 200.
    New members return 201. The last-admin guard applies on re-invite.
    """
    from fastapi import Response

    tid = _parse_team_uuid(team_id)
    await _require_role(tid, user, TeamRole.admin, db)

    invitee = (await db.execute(select(User).where(User.email == req.email))).scalar_one_or_none()
    if not invitee:
        raise HTTPException(status_code=404, detail="No user with that email")

    existing = (
        await db.execute(
            select(TeamMembership).where(
                TeamMembership.team_id == tid,
                TeamMembership.user_id == invitee.id,
            )
        )
    ).scalar_one_or_none()

    if existing:
        # Guard: cannot demote sole admin via re-invite
        if (
            existing.role == TeamRole.admin.value
            and req.role != TeamRole.admin.value
            and await _count_admins(tid, db) <= 1
        ):
            raise HTTPException(
                status_code=409,
                detail="Cannot demote the last admin. Promote another member first.",
            )
        existing.role = req.role
        await db.commit()
        # Return 200 (not 201) for an update to an existing membership.
        return Response(
            content=MemberOut(
                user_id=str(invitee.id),
                email=invitee.email,
                role=req.role,
            ).model_dump_json(),
            media_type="application/json",
            status_code=200,
        )

    db.add(TeamMembership(team_id=tid, user_id=invitee.id, role=req.role))
    await db.commit()
    return MemberOut(user_id=str(invitee.id), email=invitee.email, role=req.role)


@router.patch("/{team_id}/members/{target_user_id}", response_model=MemberOut)
@limiter.limit("20/minute")
async def update_member_role(
    request: Request,
    team_id: str,
    target_user_id: str,
    req: MemberRoleUpdate,
    user: AuthDep,
    db: DbDep,
):
    """Change a member's role. Admin only."""
    tid = _parse_team_uuid(team_id)
    tuid = _parse_user_uuid(target_user_id)
    await _require_role(tid, user, TeamRole.admin, db)

    target_m = (
        await db.execute(
            select(TeamMembership).where(
                TeamMembership.team_id == tid,
                TeamMembership.user_id == tuid,
            )
        )
    ).scalar_one_or_none()
    if not target_m:
        raise HTTPException(status_code=404, detail="Member not found")

    if target_m.role == TeamRole.admin.value and req.role != TeamRole.admin.value and await _count_admins(tid, db) <= 1:
        raise HTTPException(
            status_code=409,
            detail="Cannot demote the last admin. Promote another member first.",
        )

    target_m.role = req.role
    await db.commit()

    target_user = await db.get(User, tuid)
    if not target_user:
        # User was deleted after their membership was checked — return what we have
        return MemberOut(user_id=target_user_id, email="(deleted)", role=req.role)
    return MemberOut(user_id=target_user_id, email=target_user.email, role=req.role)


@router.delete("/{team_id}/members/{target_user_id}", status_code=204)
@limiter.limit("20/minute")
async def remove_member(
    request: Request,
    team_id: str,
    target_user_id: str,
    user: AuthDep,
    db: DbDep,
):
    """Remove a member. Admin only; a member may remove themselves regardless of role."""
    tid = _parse_team_uuid(team_id)
    tuid = _parse_user_uuid(target_user_id)

    if user.id != tuid:
        await _require_role(tid, user, TeamRole.admin, db)

    m = (
        await db.execute(
            select(TeamMembership).where(
                TeamMembership.team_id == tid,
                TeamMembership.user_id == tuid,
            )
        )
    ).scalar_one_or_none()
    if not m:
        raise HTTPException(status_code=404, detail="Member not found")

    if m.role == TeamRole.admin.value and await _count_admins(tid, db) <= 1:
        raise HTTPException(
            status_code=409,
            detail="Cannot remove the last admin. Transfer admin role first.",
        )

    await db.delete(m)
    await db.commit()


# ── Flow sharing ──────────────────────────────────────────────────────────────


@router.get("/{team_id}/flows", response_model=list[SharedFlowOut])
async def list_shared_flows(team_id: str, user: AuthDep, db: DbDep):
    """List flows shared with a team. Any member may call this."""
    tid = _parse_team_uuid(team_id)
    await _get_membership(tid, user.id, db)

    rows = (
        await db.execute(
            select(FlowPermission, Flow)
            .join(Flow, Flow.id == FlowPermission.flow_id)
            .where(FlowPermission.team_id == tid)
            .order_by(Flow.name)
        )
    ).all()
    return [SharedFlowOut(flow_id=fp.flow_id, flow_name=flow.name, permission=fp.permission) for fp, flow in rows]


@router.post("/{team_id}/flows/{flow_id}", response_model=FlowPermissionOut, status_code=201)
@limiter.limit("20/minute")
async def share_flow(
    request: Request,
    team_id: str,
    flow_id: str,
    req: FlowShareRequest,
    user: AuthDep,
    db: DbDep,
):
    """Share a flow with a team. Admin only; caller must also own the flow.

    Re-sharing updates the permission level (idempotent).
    """
    tid = _parse_team_uuid(team_id)
    await _require_role(tid, user, TeamRole.admin, db)

    flow = await db.get(Flow, flow_id)
    if not flow or str(flow.user_id) != str(user.id):
        raise HTTPException(status_code=404, detail="Flow not found or not owned by you")

    existing = (
        await db.execute(
            select(FlowPermission).where(
                FlowPermission.flow_id == flow_id,
                FlowPermission.team_id == tid,
            )
        )
    ).scalar_one_or_none()

    if existing:
        existing.permission = req.permission
    else:
        db.add(FlowPermission(flow_id=flow_id, team_id=tid, permission=req.permission))
    await db.commit()

    return FlowPermissionOut(flow_id=flow_id, team_id=team_id, permission=req.permission)


@router.delete("/{team_id}/flows/{flow_id}", status_code=204)
@limiter.limit("20/minute")
async def unshare_flow(request: Request, team_id: str, flow_id: str, user: AuthDep, db: DbDep):
    """Revoke a team's access to a flow. Admin only."""
    tid = _parse_team_uuid(team_id)
    await _require_role(tid, user, TeamRole.admin, db)

    fp = (
        await db.execute(
            select(FlowPermission).where(
                FlowPermission.flow_id == flow_id,
                FlowPermission.team_id == tid,
            )
        )
    ).scalar_one_or_none()
    if not fp:
        raise HTTPException(status_code=404, detail="Flow not shared with this team")

    await db.delete(fp)
    await db.commit()
