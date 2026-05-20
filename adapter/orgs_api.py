"""
Org (organisation) management API — Phase 3 multi-tenant namespacing.

Every user has exactly one personal org created on registration.
Additional orgs can be created for teams / enterprise customers.

Endpoints
  GET    /orgs                       → list orgs the caller belongs to
  POST   /orgs                       → create a new org
  GET    /orgs/{org_id}              → org detail + members
  PATCH  /orgs/{org_id}              → rename org or set Langfuse keys (admin only)
  DELETE /orgs/{org_id}              → delete org (admin only, not personal org)

  GET    /orgs/{org_id}/members      → list members
  POST   /orgs/{org_id}/members      → invite user by email (admin only)
  PATCH  /orgs/{org_id}/members/{uid} → change role (admin only)
  DELETE /orgs/{org_id}/members/{uid} → remove member (admin only)

Design notes:
  - Personal orgs (owner_id == caller) cannot be deleted.
  - Langfuse keys on the org are write-only from the API (not returned in GET).
    Use PATCH with null values to clear them and fall back to global env vars.
  - Role hierarchy: admin > member.  Admins can manage members and org settings.
"""
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from rate_limit import limiter
from pydantic import BaseModel, EmailStr, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from auth import current_user
from db import Org, OrgMembership, OrgRole, User, get_session
from org_context import OrgDep, ensure_personal_org

router  = APIRouter(prefix="/orgs", tags=["orgs"])
AuthDep = Annotated[User,         Depends(current_user)]
DbDep   = Annotated[AsyncSession, Depends(get_session)]

_ROLE_RANK = {OrgRole.member: 0, OrgRole.admin: 1}


# ── UUID helpers ──────────────────────────────────────────────────────────────

def _parse_uuid(val: str, label: str = "id") -> uuid.UUID:
    try:
        return uuid.UUID(val)
    except (ValueError, AttributeError):
        raise HTTPException(status_code=422, detail=f"Invalid {label}: {val!r}") from None


# ── Pydantic schemas ──────────────────────────────────────────────────────────

class OrgCreate(BaseModel):
    name: str

    @field_validator("name")
    @classmethod
    def name_not_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("name must not be empty")
        return v.strip()


class OrgUpdate(BaseModel):
    name:                str | None = None
    langfuse_public_key: str | None = None   # pass "" to clear
    langfuse_secret_key: str | None = None   # pass "" to clear


class MemberInvite(BaseModel):
    email: EmailStr
    role:  str = OrgRole.member.value

    @field_validator("role")
    @classmethod
    def valid_role(cls, v: str) -> str:
        if v not in (OrgRole.admin.value, OrgRole.member.value):
            raise ValueError(f"role must be 'admin' or 'member', got {v!r}")
        return v


class MemberRoleUpdate(BaseModel):
    role: str

    @field_validator("role")
    @classmethod
    def valid_role(cls, v: str) -> str:
        if v not in (OrgRole.admin.value, OrgRole.member.value):
            raise ValueError(f"role must be 'admin' or 'member', got {v!r}")
        return v


class MemberOut(BaseModel):
    user_id: str
    email:   str
    role:    str


class OrgOut(BaseModel):
    id:         str
    name:       str
    owner_id:   str | None
    # Langfuse keys intentionally omitted — write-only from the API.
    has_langfuse_keys: bool
    members:    list[MemberOut]
    created_at: str


class OrgSummary(BaseModel):
    id:   str
    name: str
    role: str


# ── Internal helpers ──────────────────────────────────────────────────────────

async def _get_org_owned(org_id: uuid.UUID, db: AsyncSession) -> Org:
    org = await db.get(Org, org_id)
    if not org:
        raise HTTPException(status_code=404, detail="Org not found")
    return org


async def _require_admin(org_id: uuid.UUID, user: User, db: AsyncSession) -> None:
    m = (await db.execute(
        select(OrgMembership).where(
            OrgMembership.org_id  == org_id,
            OrgMembership.user_id == user.id,
        )
    )).scalar_one_or_none()
    if not m or m.role != OrgRole.admin.value:
        raise HTTPException(status_code=403, detail="Admin role required")


async def _admin_count(org_id: uuid.UUID, db: AsyncSession) -> int:
    rows = (await db.execute(
        select(OrgMembership).where(
            OrgMembership.org_id == org_id,
            OrgMembership.role   == OrgRole.admin.value,
        )
    )).scalars().all()
    return len(rows)


async def _build_org_out(org: Org, db: AsyncSession) -> OrgOut:
    memberships = (await db.execute(
        select(OrgMembership, User)
        .join(User, User.id == OrgMembership.user_id)
        .where(OrgMembership.org_id == org.id)
        .order_by(User.email)
    )).all()
    members = [
        MemberOut(user_id=str(u.id), email=u.email, role=m.role)
        for m, u in memberships
    ]
    return OrgOut(
        id         = str(org.id),
        name       = org.name,
        owner_id   = str(org.owner_id) if org.owner_id else None,
        has_langfuse_keys = bool(org.langfuse_public_key and org.langfuse_secret_key),
        members    = members,
        created_at = org.created_at.isoformat() if org.created_at else "",
    )


# ── Org CRUD ──────────────────────────────────────────────────────────────────

@router.get("", response_model=list[OrgSummary])
async def list_orgs(user: AuthDep, db: DbDep):
    """Return all orgs the caller belongs to."""
    rows = (await db.execute(
        select(OrgMembership, Org)
        .join(Org, Org.id == OrgMembership.org_id)
        .where(OrgMembership.user_id == user.id)
        .order_by(Org.name)
    )).all()
    return [OrgSummary(id=str(org.id), name=org.name, role=m.role)
            for m, org in rows]


@router.post("", response_model=OrgOut, status_code=201)
@limiter.limit("20/minute")
async def create_org(req: OrgCreate, user: AuthDep, db: DbDep):
    """Create a new org. The caller becomes the admin and owner."""
    org = Org(name=req.name, owner_id=user.id)
    db.add(org)
    await db.flush()
    db.add(OrgMembership(org_id=org.id, user_id=user.id, role=OrgRole.admin.value))
    await db.commit()
    await db.refresh(org)
    return await _build_org_out(org, db)


@router.get("/{org_id}", response_model=OrgOut)
@limiter.limit("20/minute")
async def get_org(org_id: str, user: AuthDep, db: DbDep):
    oid = _parse_uuid(org_id, "org_id")
    # Verify membership.
    m = (await db.execute(
        select(OrgMembership).where(
            OrgMembership.org_id  == oid,
            OrgMembership.user_id == user.id,
        )
    )).scalar_one_or_none()
    if not m:
        raise HTTPException(status_code=404, detail="Org not found")
    org = await db.get(Org, oid)
    if not org:
        raise HTTPException(status_code=404, detail="Org not found")
    return await _build_org_out(org, db)


@router.patch("/{org_id}", response_model=OrgOut)
@limiter.limit("20/minute")
async def update_org(
    request: Request,
    org_id: str, req: OrgUpdate, user: AuthDep, db: DbDep):
    """Rename the org or update its Langfuse project keys. Admin only."""
    oid = _parse_uuid(org_id, "org_id")
    await _require_admin(oid, user, db)
    org = await _get_org_owned(oid, db)

    if req.name is not None:
        stripped = req.name.strip()
        if not stripped:
            raise HTTPException(status_code=400, detail="name must not be empty")
        org.name = stripped

    # Langfuse keys: explicit None means "don't touch"; explicit "" means "clear".
    if req.langfuse_public_key is not None:
        org.langfuse_public_key = req.langfuse_public_key or None
    if req.langfuse_secret_key is not None:
        org.langfuse_secret_key = req.langfuse_secret_key or None

    await db.commit()
    await db.refresh(org)
    return await _build_org_out(org, db)


@router.delete("/{org_id}", status_code=204)
@limiter.limit("20/minute")
async def delete_org(
    request: Request,
    org_id: str, user: AuthDep, db: DbDep):
    """Delete an org and cascade to memberships. Admin only.

    Personal orgs (owner_id == caller) cannot be deleted to protect the
    user's data isolation boundary.
    """
    oid = _parse_uuid(org_id, "org_id")
    await _require_admin(oid, user, db)
    org = await _get_org_owned(oid, db)

    if org.is_personal == "true":
        raise HTTPException(
            status_code=409,
            detail="Cannot delete your personal org. Delete your account instead.",
        )

    await db.delete(org)
    await db.commit()


# ── Member management ─────────────────────────────────────────────────────────

@router.get("/{org_id}/members", response_model=list[MemberOut])
@limiter.limit("20/minute")
async def list_members(org_id: str, user: AuthDep, db: DbDep):
    oid = _parse_uuid(org_id, "org_id")
    # Any member can list members.
    m = (await db.execute(
        select(OrgMembership).where(
            OrgMembership.org_id  == oid,
            OrgMembership.user_id == user.id,
        )
    )).scalar_one_or_none()
    if not m:
        raise HTTPException(status_code=404, detail="Org not found")

    rows = (await db.execute(
        select(OrgMembership, User)
        .join(User, User.id == OrgMembership.user_id)
        .where(OrgMembership.org_id == oid)
        .order_by(User.email)
    )).all()
    return [MemberOut(user_id=str(u.id), email=u.email, role=m2.role)
            for m2, u in rows]


@router.post("/{org_id}/members", response_model=MemberOut, status_code=201)
@limiter.limit("20/minute")
async def invite_member(
    request: Request,
    org_id: str, req: MemberInvite, user: AuthDep, db: DbDep):
    """Invite a user by email. Admin only. Re-inviting updates the role (returns 200)."""
    from fastapi import Response
    from fastapi.responses import JSONResponse
    oid = _parse_uuid(org_id, "org_id")
    await _require_admin(oid, user, db)

    invitee = (await db.execute(
        select(User).where(User.email == req.email)
    )).scalar_one_or_none()
    if not invitee:
        raise HTTPException(status_code=404, detail="No user with that email")

    existing = (await db.execute(
        select(OrgMembership).where(
            OrgMembership.org_id  == oid,
            OrgMembership.user_id == invitee.id,
        )
    )).scalar_one_or_none()

    if existing:
        existing.role = req.role
        await db.commit()
        return JSONResponse(
            status_code=200,
            content=MemberOut(user_id=str(invitee.id), email=invitee.email,
                              role=existing.role).model_dump(),
        )

    db.add(OrgMembership(org_id=oid, user_id=invitee.id, role=req.role))
    await db.commit()
    return MemberOut(user_id=str(invitee.id), email=invitee.email, role=req.role)


@router.patch("/{org_id}/members/{member_id}", response_model=MemberOut)
@limiter.limit("20/minute")
async def change_member_role(
    request: Request,
    org_id: str, member_id: str,
                              req: MemberRoleUpdate, user: AuthDep, db: DbDep):
    """Change a member's role. Admin only. Last-admin guard applies."""
    oid = _parse_uuid(org_id,   "org_id")
    mid = _parse_uuid(member_id, "member_id")
    await _require_admin(oid, user, db)

    m = (await db.execute(
        select(OrgMembership).where(
            OrgMembership.org_id  == oid,
            OrgMembership.user_id == mid,
        )
    )).scalar_one_or_none()
    if not m:
        raise HTTPException(status_code=404, detail="Member not found")

    # Last-admin guard.
    if m.role == OrgRole.admin.value and req.role != OrgRole.admin.value:
        if await _admin_count(oid, db) <= 1:
            raise HTTPException(status_code=409, detail="Cannot demote the last admin")

    member_user = await db.get(User, mid)
    m.role = req.role
    await db.commit()
    return MemberOut(
        user_id = str(mid),
        email   = member_user.email if member_user else "",
        role    = m.role,
    )


@router.delete("/{org_id}/members/{member_id}", status_code=204)
@limiter.limit("20/minute")
async def remove_member(
    request: Request,
    org_id: str, member_id: str, user: AuthDep, db: DbDep):
    """Remove a member. Admin only. Last-admin guard applies.

    Members can remove themselves from an org they don't own.
    """
    oid = _parse_uuid(org_id,   "org_id")
    mid = _parse_uuid(member_id, "member_id")

    # Fetch membership first — if the target isn't a member, 404 regardless
    # of whether the caller is an admin or is self-removing.
    m = (await db.execute(
        select(OrgMembership).where(
            OrgMembership.org_id  == oid,
            OrgMembership.user_id == mid,
        )
    )).scalar_one_or_none()
    if not m:
        raise HTTPException(status_code=404, detail="Member not found")

    # Allow self-removal without admin requirement; otherwise require admin.
    if str(mid) != str(user.id):
        await _require_admin(oid, user, db)

    # Last-admin guard.
    if m.role == OrgRole.admin.value:
        if await _admin_count(oid, db) <= 1:
            raise HTTPException(status_code=409, detail="Cannot remove the last admin")

    await db.delete(m)
    await db.commit()
