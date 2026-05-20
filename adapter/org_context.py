"""
org_context.py — Active-org resolution for multi-tenant namespacing.

Every authenticated request operates within exactly one org.  This module
provides the FastAPI dependency `current_org` that resolves which org the
caller is acting under.

Resolution order
----------------
1. X-Org-ID request header  (explicit, e.g. from a multi-org dashboard)
2. ?org_id= query parameter (explicit, useful for API clients)
3. Personal org             (the caller's own org — always exists; created on
                             registration via `ensure_personal_org`)

The resolved org is validated: the caller must be a member.  If they are not,
401 is raised (same status as auth failure — no information leakage about org
existence).

Public helpers
--------------
ensure_personal_org(user, db) → Org
    Idempotently create the personal org for a user if it does not yet exist.
    Called from POST /auth/register.

get_langfuse_keys(org) → (public_key, secret_key)
    Return the effective Langfuse API keys for the org: per-org keys if set,
    otherwise the global LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY env vars.
    Used by eval_api and prompt_resolver.
"""
from __future__ import annotations

import os
import uuid
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from auth import current_user
from db import Org, OrgMembership, OrgRole, User, get_session


# ── Public helper: ensure personal org ───────────────────────────────────────

async def ensure_personal_org(user: User, db: AsyncSession) -> Org:
    """Idempotently return (or create) the personal org for *user*.

    Called from POST /auth/register after the user row is committed.
    Also called lazily by `current_org` so existing users without a personal
    org (e.g. created before migration 0005) get one on their next request.
    """
    # Fast path: check membership table.
    existing = (
        await db.execute(
            select(Org)
            .join(OrgMembership, OrgMembership.org_id == Org.id)
            .where(
                OrgMembership.user_id == user.id,
                OrgMembership.role    == OrgRole.admin.value,
                Org.owner_id          == user.id,
            )
            .limit(1)
        )
    ).scalar_one_or_none()

    if existing:
        return existing

    # Create the personal org.
    email: str = user.email or ""
    name  = email.split("@")[0] if "@" in email else str(user.id)[:8]
    org   = Org(
        name        = f"{name}'s workspace",
        owner_id    = user.id,
        is_personal = "true",
    )
    db.add(org)
    try:
        await db.flush()   # get org.id before adding membership
    except Exception:
        # Concurrent request already created the personal org (race on the
        # unique partial index ix_orgs_personal_per_owner).  Roll back the
        # attempted insert and re-query for the winner's row.
        await db.rollback()
        existing = (
            await db.execute(
                select(Org)
                .join(OrgMembership, OrgMembership.org_id == Org.id)
                .where(
                    OrgMembership.user_id == user.id,
                    OrgMembership.role    == OrgRole.admin.value,
                    Org.owner_id          == user.id,
                )
                .limit(1)
            )
        ).scalar_one_or_none()
        if existing:
            return existing
        raise  # unexpected error — re-raise

    db.add(OrgMembership(
        org_id  = org.id,
        user_id = user.id,
        role    = OrgRole.admin.value,
    ))
    await db.commit()
    await db.refresh(org)
    return org


# ── Public helper: Langfuse key resolution ────────────────────────────────────

def get_langfuse_keys(org: Org | None) -> tuple[str, str]:
    """Return (public_key, secret_key) for the org.

    Per-org keys are used only when BOTH are configured on the org row.
    If only one is set (misconfiguration), fall back to global env vars for
    both — mixing keys from two different Langfuse projects would cause auth
    failures that are harder to debug than a clean fallback.

    Returns ('', '') when neither the org nor env vars have keys set.
    """
    org_pub = (org.langfuse_public_key if org else None) or ""
    org_sec = (org.langfuse_secret_key if org else None) or ""

    if org_pub and org_sec:
        # Both per-org keys are present — use them exclusively.
        return org_pub, org_sec

    # Fall back to global env vars (single-tenant installs / dev).
    return (
        os.getenv("LANGFUSE_PUBLIC_KEY", ""),
        os.getenv("LANGFUSE_SECRET_KEY", ""),
    )


# ── FastAPI dependency ────────────────────────────────────────────────────────

async def current_org(
    user:       User         = Depends(current_user),
    db:         AsyncSession = Depends(get_session),
    x_org_id:   str | None   = Header(default=None, alias="X-Org-ID"),
    org_id_qp:  str | None   = Query(default=None,  alias="org_id"),
) -> Org:
    """Resolve the active org for the current request.

    Priority: X-Org-ID header → ?org_id= query param → personal org.

    The caller must be a member of the resolved org; raises 401 otherwise.
    """
    explicit_id: str | None = x_org_id or org_id_qp

    if explicit_id:
        try:
            org_uuid = uuid.UUID(explicit_id)
        except (ValueError, AttributeError):
            raise HTTPException(status_code=422, detail=f"Invalid org_id: {explicit_id!r}")

        # Verify membership.
        membership = (
            await db.execute(
                select(OrgMembership).where(
                    OrgMembership.org_id  == org_uuid,
                    OrgMembership.user_id == user.id,
                )
            )
        ).scalar_one_or_none()

        if not membership:
            # 401 not 403 — we don't confirm whether the org exists.
            raise HTTPException(status_code=401, detail="Not a member of this org")

        org = await db.get(Org, org_uuid)
        if not org:
            raise HTTPException(status_code=401, detail="Not a member of this org")
        return org

    # Fall back to personal org (lazy-create if missing).
    return await ensure_personal_org(user, db)


# ── Type alias for route signatures ──────────────────────────────────────────

OrgDep = Annotated[Org, Depends(current_org)]
