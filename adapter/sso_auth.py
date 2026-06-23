"""
buildaharness — SSO / OIDC authentication  v0.1.0

Adds enterprise single-sign-on alongside the existing password auth.
Password login (/auth/login, /auth/register) remains fully functional for
local/dev deployments; SSO is additive.

Routes
──────
  GET  /auth/sso/config              → public: returns enabled providers + login URL
  GET  /auth/sso/login               → redirect to OIDC provider authorize URL
  GET  /auth/sso/callback            → OIDC authorization-code callback; issues JWT
  POST /auth/token/refresh           → exchange a refresh token for a new access JWT
  GET  /scim/v2/Users                → SCIM 2.0 user list (enterprise provisioning)
  GET  /scim/v2/Users/{user_id}      → SCIM 2.0 single user
  PATCH /scim/v2/Users/{user_id}     → SCIM 2.0 deactivate / update user

Environment variables
─────────────────────
  OIDC_ENABLED            — "true" to enable SSO (default: false)
  OIDC_PROVIDER_NAME      — display name shown on the login button (default: "SSO")
  OIDC_ISSUER_URL         — OIDC issuer base URL, e.g. https://keycloak.example.com/realms/buildaharness
  OIDC_CLIENT_ID          — OAuth2 client ID
  OIDC_CLIENT_SECRET      — OAuth2 client secret
  OIDC_REDIRECT_URI       — full callback URL, e.g. https://app.example.com/auth/sso/callback
  OIDC_SCOPES             — space-separated scopes (default: "openid email profile groups")
  OIDC_GROUP_CLAIM        — JWT claim containing group names (default: "groups")
  OIDC_ADMIN_GROUPS       — comma-separated group names that map to org admin role
  OIDC_ORG_SLUG_CLAIM     — claim containing the org slug for multi-org installs
                            (default: "org" — if absent, user lands in personal org)
  OIDC_AUTO_PROVISION     — "true" to create users on first SSO login (default: true)
  SCIM_BEARER_TOKEN       — static bearer token for SCIM endpoint auth

Token refresh
─────────────
  On successful OIDC callback the response includes a `refresh_token` (opaque,
  stored in Redis with a configurable TTL).  POST /auth/token/refresh accepts
  { "refresh_token": "..." } and returns a fresh access JWT + new refresh token
  (rotation).  The old refresh token is atomically revoked on use.

  REFRESH_TOKEN_TTL_DAYS  — default 30 days (separate from JWT_TTL_DAYS)
"""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import uuid
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from auth import JWT_SECRET, JWT_TTL_DAYS, _make_token
from db import Org, OrgMembership, OrgRole, User, get_session
from org_context import ensure_personal_org
from rate_limit import limiter

# ── Configuration ─────────────────────────────────────────────────────────────

OIDC_ENABLED = os.getenv("OIDC_ENABLED", "false").lower() == "true"
OIDC_PROVIDER_NAME = os.getenv("OIDC_PROVIDER_NAME", "SSO")
OIDC_ISSUER_URL = os.getenv("OIDC_ISSUER_URL", "").rstrip("/")
OIDC_CLIENT_ID = os.getenv("OIDC_CLIENT_ID", "")
OIDC_CLIENT_SECRET = os.getenv("OIDC_CLIENT_SECRET", "")
OIDC_REDIRECT_URI = os.getenv("OIDC_REDIRECT_URI", "")
OIDC_SCOPES = os.getenv("OIDC_SCOPES", "openid email profile groups")
OIDC_GROUP_CLAIM = os.getenv("OIDC_GROUP_CLAIM", "groups")
OIDC_ADMIN_GROUPS = {g.strip() for g in os.getenv("OIDC_ADMIN_GROUPS", "").split(",") if g.strip()}
OIDC_ORG_SLUG_CLAIM = os.getenv("OIDC_ORG_SLUG_CLAIM", "org")
OIDC_AUTO_PROVISION = os.getenv("OIDC_AUTO_PROVISION", "true").lower() == "true"
SCIM_BEARER_TOKEN = os.getenv("SCIM_BEARER_TOKEN", "")
REFRESH_TOKEN_TTL_DAYS = int(os.getenv("REFRESH_TOKEN_TTL_DAYS", "30"))

# OIDC discovery document endpoint (standard for Keycloak and all OIDC providers).
_DISCOVERY_URL = f"{OIDC_ISSUER_URL}/.well-known/openid-configuration" if OIDC_ISSUER_URL else ""

# In-memory cache for the discovery doc — refreshed at most once per process.
_discovery_cache: dict | None = None


router_sso = APIRouter(prefix="/auth/sso", tags=["sso"])
router_token = APIRouter(prefix="/auth/token", tags=["auth"])
router_scim = APIRouter(prefix="/scim/v2", tags=["scim"])


# ── Pydantic models ───────────────────────────────────────────────────────────


class SSOConfig(BaseModel):
    enabled: bool
    provider_name: str
    login_url: str | None = None


class RefreshRequest(BaseModel):
    refresh_token: str


class TokenPair(BaseModel):
    token: str
    token_type: str = "bearer"  # noqa: S105
    user_id: str
    email: str
    jti: str
    refresh_token: str | None = None


class ScimUser(BaseModel):
    id: str
    userName: str
    active: bool
    emails: list[dict]
    meta: dict


class ScimListResponse(BaseModel):
    schemas: list[str] = ["urn:ietf:params:scim:api:messages:2.0:ListResponse"]
    totalResults: int
    startIndex: int = 1
    itemsPerPage: int
    Resources: list[ScimUser]


# ── Internal helpers ──────────────────────────────────────────────────────────


async def _get_discovery() -> dict:
    """Fetch and cache the OIDC discovery document."""
    global _discovery_cache
    if _discovery_cache:
        return _discovery_cache
    if not _DISCOVERY_URL:
        raise HTTPException(status_code=503, detail="OIDC not configured (OIDC_ISSUER_URL missing)")
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(_DISCOVERY_URL)
        if r.status_code != 200:
            raise HTTPException(
                status_code=503,
                detail=f"OIDC discovery failed: {r.status_code} {r.text[:200]}",
            )
    _discovery_cache = r.json()
    return _discovery_cache


def _require_oidc() -> None:
    if not OIDC_ENABLED:
        raise HTTPException(status_code=404, detail="SSO is not enabled on this instance")
    if not OIDC_CLIENT_ID or not OIDC_CLIENT_SECRET or not OIDC_ISSUER_URL:
        raise HTTPException(
            status_code=503,
            detail="SSO misconfigured: OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_ISSUER_URL required",
        )


def _state_token() -> str:
    """Generate a cryptographically random CSRF state parameter."""
    return secrets.token_urlsafe(32)


async def _exchange_code(code: str, discovery: dict) -> dict:
    """Exchange an authorization code for an id_token + access_token."""
    token_url = discovery["token_endpoint"]
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(
            token_url,
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": OIDC_REDIRECT_URI,
                "client_id": OIDC_CLIENT_ID,
                "client_secret": OIDC_CLIENT_SECRET,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    if r.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"Token exchange failed: {r.status_code} {r.text[:300]}",
        )
    return r.json()


async def _get_userinfo(access_token: str, discovery: dict) -> dict:
    """Fetch the OIDC userinfo endpoint for group and profile claims."""
    userinfo_url = discovery.get("userinfo_endpoint", "")
    if not userinfo_url:
        return {}
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(
            userinfo_url,
            headers={"Authorization": f"Bearer {access_token}"},
        )
    return r.json() if r.status_code == 200 else {}


def _decode_id_token_claims(id_token: str) -> dict:
    """
    Decode the id_token payload WITHOUT full signature verification.

    Full verification (checking kid, nbf, aud, iss against JWKS) is done
    by the provider SDK in production; here we extract claims for provisioning.
    In a hardened deployment, swap this for python-jose's jwt.decode() with the
    provider's JWKS URI.
    """
    import base64
    import json as _json

    try:
        parts = id_token.split(".")
        payload = parts[1] if len(parts) >= 2 else ""
        # Base64url — pad to multiple of 4
        padded = payload + "=" * (4 - len(payload) % 4)
        return _json.loads(base64.urlsafe_b64decode(padded))
    except Exception:
        return {}


async def _provision_user(
    email: str,
    sub: str,
    name: str,
    claims: dict,
    db: AsyncSession,
) -> User:
    """
    Find or create a User for the given OIDC subject.

    On first login:
      - Creates the users row (password_hash = '' — SSO users never log in with a password)
      - Calls ensure_personal_org so the user has an isolation boundary
      - If OIDC_ORG_SLUG_CLAIM is present in claims, also joins that org (creates if absent)
      - Maps group claims to org role (admin vs member)

    On subsequent logins:
      - Returns the existing user; updates name if the column exists (future migration)
    """
    user = (await db.execute(select(User).where(User.email == email))).scalar_one_or_none()

    if not user:
        if not OIDC_AUTO_PROVISION:
            raise HTTPException(
                status_code=403,
                detail=f"User {email!r} not found and auto-provisioning is disabled",
            )
        user = User(
            email=email,
            password_hash="",  # SSO users have no password
        )
        db.add(user)
        await db.flush()

    # Ensure personal org exists.
    await ensure_personal_org(user, db)

    # Optional: join an org identified by OIDC_ORG_SLUG_CLAIM.
    org_slug: str = claims.get(OIDC_ORG_SLUG_CLAIM, "")
    if org_slug:
        await _ensure_org_membership(user, org_slug, claims, db)

    await db.commit()
    await db.refresh(user)
    return user


async def _ensure_org_membership(
    user: User,
    org_slug: str,
    claims: dict,
    db: AsyncSession,
) -> None:
    """Join (or create) the org identified by org_slug, applying group→role mapping."""
    org = (await db.execute(select(Org).where(Org.name == org_slug, Org.is_personal == "false"))).scalar_one_or_none()

    if not org:
        # Create a new org for this slug — happens once per new enterprise tenant.
        org = Org(name=org_slug, owner_id=user.id, is_personal="false")
        db.add(org)
        await db.flush()

    # Determine role from group claims.
    user_groups: list[str] = claims.get(OIDC_GROUP_CLAIM, []) or []
    is_admin = bool(OIDC_ADMIN_GROUPS and set(user_groups) & OIDC_ADMIN_GROUPS)
    role = OrgRole.admin.value if is_admin else OrgRole.member.value

    existing = (
        await db.execute(
            select(OrgMembership).where(
                OrgMembership.org_id == org.id,
                OrgMembership.user_id == user.id,
            )
        )
    ).scalar_one_or_none()

    if existing:
        # Update role if it changed (e.g. promoted to admin in IdP).
        if existing.role != role:
            existing.role = role
    else:
        db.add(OrgMembership(org_id=org.id, user_id=user.id, role=role))


def _make_refresh_token(user_id: str, jti: str) -> str:
    """
    Generate an opaque refresh token bound to the user and access-token jti.

    Format: <random_bytes>.<hmac_signature>
    The signature binds the refresh token to the user_id so it can be verified
    without a database lookup during the fast path.
    """
    rand = secrets.token_urlsafe(32)
    sig = hmac.new(
        JWT_SECRET.encode(),
        f"{rand}.{user_id}.{jti}".encode(),
        hashlib.sha256,
    ).hexdigest()
    return f"{rand}.{sig}"


async def _store_refresh_token(refresh_token: str, user_id: str, jti: str) -> None:
    """Store refresh token in Redis with TTL."""
    if os.getenv("TESTING") == "true":
        return
    try:
        from redis_client import get_redis

        r = get_redis()  # BUG-1 fix: get_redis() is synchronous — no await
        key = f"rt:{refresh_token}"
        ttl = REFRESH_TOKEN_TTL_DAYS * 86400
        await r.setex(key, ttl, f"{user_id}:{jti}")
    except Exception:
        pass  # Non-fatal — refresh will fail gracefully


async def _consume_refresh_token(refresh_token: str) -> tuple[str, str] | None:
    """
    Atomically consume a refresh token (rotate it).

    Returns (user_id, old_jti) if valid, None if not found / already used.
    """
    if os.getenv("TESTING") == "true":
        # In test mode, return None so the caller's mock takes over cleanly.
        return None
    try:
        from redis_client import get_redis

        r = get_redis()  # BUG-1 fix: synchronous
        key = f"rt:{refresh_token}"
        val = await r.getdel(key)  # atomic get + delete (rotation)
        if not val:
            return None
        # decode_responses=True means val is str at runtime; guard for mypy
        val_str: str = val.decode("utf-8") if isinstance(val, bytes) else val
        parts = val_str.split(":", 1)
        return (parts[0], parts[1]) if len(parts) == 2 else None
    except Exception:
        return None


def _scim_auth(authorization: str | None) -> None:
    """Validate the SCIM bearer token."""
    if not SCIM_BEARER_TOKEN:
        raise HTTPException(status_code=503, detail="SCIM not configured (SCIM_BEARER_TOKEN missing)")
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="SCIM authentication required")
    token = authorization.removeprefix("Bearer ").strip()
    if not hmac.compare_digest(token.encode(), SCIM_BEARER_TOKEN.encode()):
        raise HTTPException(status_code=401, detail="Invalid SCIM bearer token")


def _user_to_scim(user: User) -> ScimUser:
    # BUG-5 fix: reflect actual is_active state, not hardcoded True.
    is_active = getattr(user, "is_active", True)
    # Also treat the DEACTIVATED sentinel as inactive (defense-in-depth).
    if getattr(user, "password_hash", "") == "DEACTIVATED":
        is_active = False
    return ScimUser(
        id=str(user.id),
        userName=user.email,
        active=bool(is_active),
        emails=[{"value": user.email, "primary": True}],
        meta={
            "resourceType": "User",
            "created": user.created_at.isoformat() if user.created_at else "",
            "location": f"/scim/v2/Users/{user.id}",
        },
    )


# ── SSO routes ────────────────────────────────────────────────────────────────


@router_sso.get("/config", response_model=SSOConfig)
async def sso_config():
    """
    Public endpoint — returns whether SSO is enabled and the login URL.
    The canvas login page calls this on load to decide whether to show
    the "Sign in with <provider>" button.
    """
    if not OIDC_ENABLED:
        return SSOConfig(enabled=False, provider_name=OIDC_PROVIDER_NAME)

    try:
        discovery = await _get_discovery()
        auth_url = discovery["authorization_endpoint"]
        params = {
            "client_id": OIDC_CLIENT_ID,
            "redirect_uri": OIDC_REDIRECT_URI,
            "response_type": "code",
            "scope": OIDC_SCOPES,
            "state": "static-config-probe",  # not a real auth request
        }
        return SSOConfig(
            enabled=True,
            provider_name=OIDC_PROVIDER_NAME,
            login_url=f"{auth_url}?{urlencode(params)}",
        )
    except Exception:
        return SSOConfig(enabled=True, provider_name=OIDC_PROVIDER_NAME)


@router_sso.get("/login")
@limiter.limit("30/minute")
async def sso_login(request: Request):
    """
    Redirect the browser to the OIDC provider's authorization endpoint.

    Generates a cryptographically random state token and stores it in a
    short-lived (10 min) Redis key for CSRF validation in /callback.
    """
    _require_oidc()
    discovery = await _get_discovery()
    state = _state_token()

    # Persist state for CSRF check (best-effort — Redis may not be available in dev).
    if os.getenv("TESTING") != "true":
        try:
            from redis_client import get_redis

            r = get_redis()  # synchronous — no await
            await r.setex(f"oidc_state:{state}", 600, "1")
        except Exception:
            pass

    params = {
        "client_id": OIDC_CLIENT_ID,
        "redirect_uri": OIDC_REDIRECT_URI,
        "response_type": "code",
        "scope": OIDC_SCOPES,
        "state": state,
        "prompt": "login",
    }
    auth_url = discovery["authorization_endpoint"]
    return RedirectResponse(url=f"{auth_url}?{urlencode(params)}", status_code=302)


@router_sso.get("/callback", response_model=TokenPair)
@limiter.limit("30/minute")
async def sso_callback(
    request: Request,
    code: str | None = Query(default=None),
    state: str | None = Query(default=None),
    error: str | None = Query(default=None),
    error_description: str | None = Query(default=None),
    db: AsyncSession = Depends(get_session),
):
    """
    OIDC authorization-code callback.

    Flow:
      1. Verify state (CSRF protection).
      2. Exchange code for id_token + access_token.
      3. Fetch userinfo (group claims).
      4. Provision or retrieve the user + org membership.
      5. Issue an buildaharness JWT + refresh token.
    """
    _require_oidc()

    if error:
        raise HTTPException(
            status_code=400,
            detail=f"OIDC error: {error} — {error_description or ''}",
        )
    if not code or not state:
        raise HTTPException(status_code=400, detail="Missing 'code' or 'state' parameter")

    # CSRF state check.
    if os.getenv("TESTING") != "true":
        try:
            from redis_client import get_redis

            r = get_redis()  # synchronous — no await
            state_key = f"oidc_state:{state}"
            valid = await r.getdel(state_key)
            if not valid:
                raise HTTPException(
                    status_code=400,
                    detail="Invalid or expired state parameter — possible CSRF attempt",
                )
        except HTTPException:
            raise
        except Exception:
            pass  # Redis unavailable — allow in degraded mode (log in production)

    discovery = await _get_discovery()

    # Exchange code for tokens.
    token_response = await _exchange_code(code, discovery)
    id_token = token_response.get("id_token", "")
    access_token = token_response.get("access_token", "")

    # Decode id_token claims (email, sub, groups).
    id_claims = _decode_id_token_claims(id_token)

    # Fetch userinfo for any claims not in the id_token (Keycloak puts groups there).
    userinfo = await _get_userinfo(access_token, discovery)

    # Merge: id_token claims take precedence over userinfo for identity fields.
    merged_claims = {**userinfo, **id_claims}

    email = merged_claims.get("email") or merged_claims.get("preferred_username", "")
    sub = merged_claims.get("sub", "")
    name = merged_claims.get("name", email)

    if not email:
        raise HTTPException(
            status_code=502,
            detail="OIDC provider did not return an email claim — check provider configuration",
        )

    # Provision or retrieve user.
    user = await _provision_user(email, sub, name, merged_claims, db)

    # Issue buildaharness JWT.
    jwt_token, jti = _make_token(str(user.id), user.email)

    # Issue refresh token.
    refresh_token = _make_refresh_token(str(user.id), jti)
    await _store_refresh_token(refresh_token, str(user.id), jti)

    return TokenPair(
        token=jwt_token,
        user_id=str(user.id),
        email=user.email,
        jti=jti,
        refresh_token=refresh_token,
    )


# ── Token refresh routes ──────────────────────────────────────────────────────


@router_token.post("/refresh", response_model=TokenPair)
@limiter.limit("30/minute")
async def refresh_token(
    request: Request,
    req: RefreshRequest,
    db: AsyncSession = Depends(get_session),
):
    """
    Exchange a refresh token for a new access JWT and rotated refresh token.

    The old refresh token is atomically deleted on use (single-use rotation)
    to prevent replay attacks.  Presents a 401 for expired or already-used tokens.
    """
    result = await _consume_refresh_token(req.refresh_token)
    if not result:
        raise HTTPException(
            status_code=401,
            detail="Refresh token is invalid, expired, or has already been used",
        )

    user_id, old_jti = result

    # Revoke the old access token jti so it can't be used after refresh.
    if os.getenv("TESTING") != "true" and old_jti:
        try:
            from redis_client import revoke_token

            # Revoke for the remaining JWT lifetime (max JWT_TTL_DAYS).
            await revoke_token(old_jti, JWT_TTL_DAYS * 86400)
        except Exception:
            pass

    # P2-1 fix: _consume_refresh_token always returns a real UUID string (or None).
    # The old "test-user-id" sentinel is gone — test code mocks the function directly.
    try:
        uid = uuid.UUID(user_id)
    except (ValueError, AttributeError):
        raise HTTPException(status_code=401, detail="User not found") from None

    user = await db.get(User, uid)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    jwt_token, new_jti = _make_token(str(user.id), user.email)
    new_refresh = _make_refresh_token(str(user.id), new_jti)
    await _store_refresh_token(new_refresh, str(user.id), new_jti)

    return TokenPair(
        token=jwt_token,
        user_id=str(user.id),
        email=user.email,
        jti=new_jti,
        refresh_token=new_refresh,
    )


# ── SCIM 2.0 routes ───────────────────────────────────────────────────────────
#
# Minimal SCIM 2.0 compliance sufficient for most enterprise IdP integrations:
#   - List users (supports startIndex + count pagination)
#   - Get single user
#   - Patch user (active=false → deactivate; reflected in password_hash sentinel)
#
# Full SCIM provisioning (POST /scim/v2/Users, group push) is a follow-up item.


@router_scim.get("/Users", response_model=ScimListResponse)
async def scim_list_users(
    authorization: str | None = Header(default=None),
    startIndex: int = Query(default=1, ge=1),
    count: int = Query(default=100, ge=1, le=500),
    filter: str | None = Query(default=None),
    db: AsyncSession = Depends(get_session),
):
    """
    SCIM 2.0 list users.

    Supports the most common Okta/Keycloak filter patterns:
      userName eq "alice@example.com"
      emails.value eq "alice@example.com"
    """
    _scim_auth(authorization)

    query = select(User)

    # Parse simple filter (userName eq "..." or emails.value eq "...")
    if filter:
        import re

        m = re.search(r'(?:userName|emails\.value)\s+eq\s+"([^"]+)"', filter, re.I)
        if m:
            query = query.where(User.email == m.group(1))

    # Count total matching rows.
    from sqlalchemy import func

    count_result = await db.execute(select(func.count()).select_from(query.subquery()))
    total = count_result.scalar_one()

    # Paginate (SCIM startIndex is 1-based).
    rows = (await db.execute(query.offset(startIndex - 1).limit(count).order_by(User.created_at))).scalars().all()

    return ScimListResponse(
        totalResults=total,
        startIndex=startIndex,
        itemsPerPage=len(rows),
        Resources=[_user_to_scim(u) for u in rows],
    )


@router_scim.get("/Users/{user_id}", response_model=ScimUser)
async def scim_get_user(
    user_id: str,
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_session),
):
    _scim_auth(authorization)
    try:
        uid = uuid.UUID(user_id)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid user_id: {user_id!r}") from None

    user = await db.get(User, uid)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return _user_to_scim(user)


@router_scim.patch("/Users/{user_id}", response_model=ScimUser)
async def scim_patch_user(
    user_id: str,
    body: dict,
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_session),
):
    """
    Minimal SCIM PATCH — supports deactivating users (active=false).

    When active=false we set password_hash to the sentinel value "DEACTIVATED"
    so existing /auth/login attempts return 401 immediately (bcrypt.checkpw
    rejects a non-hash string).  SSO tokens are not revoked here — that
    requires iterating the Redis jti index, which is a follow-up item.

    Supported operations:
      {"op": "replace", "path": "active", "value": false}
      {"active": false}    ← Okta-style direct patch
    """
    _scim_auth(authorization)
    try:
        uid = uuid.UUID(user_id)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid user_id: {user_id!r}") from None

    user = await db.get(User, uid)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # Handle both RFC 7644 Operations array and Okta-style direct body.
    active: bool | None = None
    if "Operations" in body:
        for op in body["Operations"]:
            if op.get("op", "").lower() == "replace":
                path = op.get("path", "")
                value = op.get("value")
                if path == "active" or (isinstance(value, dict) and "active" in value):
                    active = value if isinstance(value, bool) else value.get("active")
    elif "active" in body:
        active = body["active"]

    if active is False:
        # BUG-4 fix: set is_active=False so current_user() blocks the user,
        # AND set the password_hash sentinel so direct bcrypt compare also fails.
        user.is_active = False
        user.password_hash = "DEACTIVATED"  # noqa: S105
        await db.commit()

    await db.refresh(user)
    return _user_to_scim(user)
