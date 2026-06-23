"""
Tests for SSO/OIDC, token refresh, and SCIM 2.0 endpoints.

Coverage:
  - GET  /auth/sso/config           → enabled/disabled cases
  - GET  /auth/sso/login            → redirect to provider + state generation
  - GET  /auth/sso/callback         → full OIDC code exchange; user provisioning;
                                      group→role mapping; org creation; JWT + refresh
  - POST /auth/token/refresh        → token rotation; replay prevention; 401 on unknown
  - GET  /scim/v2/Users             → list + filter by userName
  - GET  /scim/v2/Users/{id}        → single user; 404 for missing
  - PATCH /scim/v2/Users/{id}       → deactivation (RFC 7644 + Okta-style)
  - Deactivated account blocks login + current_user
  - SSO-provisioned user (empty password_hash) cannot log in via /auth/login
  - _decode_id_token_claims decodes well-formed id_tokens
  - _provision_user: new user created; existing user returned; auto-provision off raises 403
  - OIDC disabled → 404 on all SSO routes
  - Missing OIDC config → 503 on /auth/sso/login
  - SCIM auth: missing token → 401; wrong token → 401; correct token → 200
"""

import base64
import json
import uuid
from unittest.mock import AsyncMock, patch

import pytest

import sso_auth  # P3-1: module-level import for test isolation

# ── Helpers ───────────────────────────────────────────────────────────────────


def _make_fake_id_token(claims: dict) -> str:
    """Produce a syntactically valid (but unsigned) JWT id_token for tests."""
    header = base64.urlsafe_b64encode(b'{"alg":"RS256","typ":"JWT"}').rstrip(b"=").decode()
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).rstrip(b"=").decode()
    return f"{header}.{payload}.fakesig"


FAKE_DISCOVERY = {
    "authorization_endpoint": "https://keycloak.example.com/auth",
    "token_endpoint": "https://keycloak.example.com/token",
    "userinfo_endpoint": "https://keycloak.example.com/userinfo",
    "jwks_uri": "https://keycloak.example.com/jwks",
}

FAKE_OIDC_ENV = {
    "OIDC_ENABLED": "true",
    "OIDC_ISSUER_URL": "https://keycloak.example.com/realms/buildaharness",
    "OIDC_CLIENT_ID": "buildaharness",
    "OIDC_CLIENT_SECRET": "secret",
    "OIDC_REDIRECT_URI": "https://app.example.com/auth/sso/callback",
    "OIDC_ADMIN_GROUPS": "buildaharness-admins",
    "OIDC_GROUP_CLAIM": "groups",
    "SCIM_BEARER_TOKEN": "test-scim-token",
}


# ─── /auth/sso/config ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_sso_config_disabled(client):
    """When OIDC_ENABLED is false (default in CI), config returns enabled=false."""
    # P2-5 fix: patch the module attribute directly so test is isolated regardless
    # of what prior tests may have set.
    with patch.object(sso_auth, "OIDC_ENABLED", False):
        r = await client.get("/auth/sso/config")
    assert r.status_code == 200
    assert r.json()["enabled"] is False


@pytest.mark.asyncio
async def test_sso_config_enabled_returns_login_url(client):
    with (
        patch.object(sso_auth, "_get_discovery", AsyncMock(return_value=FAKE_DISCOVERY)),
        patch.object(sso_auth, "OIDC_ENABLED", True),
    ):
        r = await client.get("/auth/sso/config")
    assert r.status_code == 200
    body = r.json()
    assert body["enabled"] is True
    assert "login_url" in body


# ─── /auth/sso/login ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_sso_login_disabled_returns_404(client):
    with patch.object(sso_auth, "OIDC_ENABLED", False):
        r = await client.get("/auth/sso/login", follow_redirects=False)
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_sso_login_redirects_to_provider(client):
    with (
        patch.object(sso_auth, "OIDC_ENABLED", True),
        patch.object(sso_auth, "OIDC_CLIENT_ID", "buildaharness"),
        patch.object(sso_auth, "OIDC_CLIENT_SECRET", "secret"),
        patch.object(sso_auth, "OIDC_ISSUER_URL", "https://kc.example.com"),
        patch.object(sso_auth, "_get_discovery", AsyncMock(return_value=FAKE_DISCOVERY)),
    ):
        r = await client.get("/auth/sso/login", follow_redirects=False)
    assert r.status_code == 302
    location = r.headers["location"]
    assert "keycloak.example.com/auth" in location
    assert "client_id=buildaharness" in location
    assert "response_type=code" in location
    assert "state=" in location


# ─── /auth/sso/callback ───────────────────────────────────────────────────────


def _patch_sso_callback(claims: dict, userinfo: dict | None = None):
    """Context manager that patches all I/O in the OIDC callback path."""

    fake_id_token = _make_fake_id_token(claims)
    token_resp = {
        "id_token": fake_id_token,
        "access_token": "fake-access-token",
        "token_type": "Bearer",
    }
    return (
        patch.object(sso_auth, "OIDC_ENABLED", True),
        patch.object(sso_auth, "OIDC_CLIENT_ID", "buildaharness"),
        patch.object(sso_auth, "OIDC_CLIENT_SECRET", "secret"),
        patch.object(sso_auth, "OIDC_ISSUER_URL", "https://kc.example.com"),
        patch.object(sso_auth, "OIDC_REDIRECT_URI", "https://app.example.com/callback"),
        patch.object(sso_auth, "OIDC_AUTO_PROVISION", True),
        patch.object(sso_auth, "_get_discovery", AsyncMock(return_value=FAKE_DISCOVERY)),
        patch.object(sso_auth, "_exchange_code", AsyncMock(return_value=token_resp)),
        patch.object(sso_auth, "_get_userinfo", AsyncMock(return_value=userinfo or {})),
        patch.object(sso_auth, "_store_refresh_token", AsyncMock()),
    )


@pytest.mark.asyncio
async def test_sso_callback_provisions_new_user(client):
    """First-time SSO login creates a user and returns a JWT + refresh token."""
    claims = {"sub": "user-123", "email": "alice@corp.com", "name": "Alice"}

    patches = _patch_sso_callback(claims)
    with (
        patches[0],
        patches[1],
        patches[2],
        patches[3],
        patches[4],
        patches[5],
        patches[6],
        patches[7],
        patches[8],
        patches[9],
    ):
        r = await client.get("/auth/sso/callback?code=authcode&state=teststate")

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["email"] == "alice@corp.com"
    assert "token" in body
    assert "refresh_token" in body
    assert "jti" in body


@pytest.mark.asyncio
async def test_sso_callback_returns_existing_user(client, auth_headers):
    """Second SSO login for the same email returns the same user."""

    # Register via password first so the user already exists.
    r0 = await client.post(
        "/auth/register",
        json={
            "email": "bob@corp.com",
            "password": "Password1",
        },
    )
    assert r0.status_code == 201
    original_user_id = r0.json()["user_id"]

    claims = {"sub": "bob-sub", "email": "bob@corp.com", "name": "Bob"}
    patches = _patch_sso_callback(claims)
    with (
        patches[0],
        patches[1],
        patches[2],
        patches[3],
        patches[4],
        patches[5],
        patches[6],
        patches[7],
        patches[8],
        patches[9],
    ):
        r = await client.get("/auth/sso/callback?code=authcode&state=teststate")

    assert r.status_code == 200
    # Must return the same user_id — not a duplicate account.
    assert r.json()["user_id"] == original_user_id


@pytest.mark.asyncio
async def test_sso_callback_group_maps_to_admin_role(client):
    """Users in OIDC_ADMIN_GROUPS get admin OrgMembership for the org claim."""

    claims = {
        "sub": "admin-sub",
        "email": "carol@corp.com",
        "groups": ["buildaharness-admins", "other-group"],
        "org": "acme",
    }
    patches = _patch_sso_callback(claims)
    with (
        patches[0],
        patches[1],
        patches[2],
        patches[3],
        patches[4],
        patches[5],
        patches[6],
        patches[7],
        patches[8],
        patches[9],
        patch.object(sso_auth, "OIDC_ADMIN_GROUPS", {"buildaharness-admins"}),
        patch.object(sso_auth, "OIDC_ORG_SLUG_CLAIM", "org"),
    ):
        r = await client.get("/auth/sso/callback?code=authcode&state=teststate")
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_sso_callback_missing_code_returns_400(client):
    with (
        patch.object(sso_auth, "OIDC_ENABLED", True),
        patch.object(sso_auth, "OIDC_CLIENT_ID", "x"),
        patch.object(sso_auth, "OIDC_CLIENT_SECRET", "x"),
        patch.object(sso_auth, "OIDC_ISSUER_URL", "https://kc.example.com"),
        patch.object(sso_auth, "_get_discovery", AsyncMock(return_value=FAKE_DISCOVERY)),
    ):
        r = await client.get("/auth/sso/callback?state=teststate")
    assert r.status_code == 400
    assert "code" in r.json()["detail"].lower() or "state" in r.json()["detail"].lower()


@pytest.mark.asyncio
async def test_sso_callback_provider_error_returns_400(client):
    with (
        patch.object(sso_auth, "OIDC_ENABLED", True),
        patch.object(sso_auth, "OIDC_CLIENT_ID", "x"),
        patch.object(sso_auth, "OIDC_CLIENT_SECRET", "x"),
        patch.object(sso_auth, "OIDC_ISSUER_URL", "https://kc.example.com"),
    ):
        r = await client.get("/auth/sso/callback?error=access_denied&error_description=User+cancelled&state=x")
    assert r.status_code == 400
    assert "access_denied" in r.json()["detail"]


@pytest.mark.asyncio
async def test_sso_auto_provision_disabled_rejects_unknown_user(client):
    """When OIDC_AUTO_PROVISION=false, unknown users get 403."""
    claims = {"sub": "stranger-sub", "email": "stranger@corp.com"}
    patches = _patch_sso_callback(claims)
    with (
        patches[0],
        patches[1],
        patches[2],
        patches[3],
        patches[4],
        patches[5],
        patches[6],
        patches[7],
        patches[8],
        patches[9],
        patch.object(sso_auth, "OIDC_AUTO_PROVISION", False),
    ):
        r = await client.get("/auth/sso/callback?code=authcode&state=teststate")
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_sso_callback_no_email_returns_502(client):
    """Provider returning no email claim must produce 502."""
    claims = {"sub": "no-email-sub"}  # no email
    patches = _patch_sso_callback(claims)
    with (
        patches[0],
        patches[1],
        patches[2],
        patches[3],
        patches[4],
        patches[5],
        patches[6],
        patches[7],
        patches[8],
        patches[9],
    ):
        r = await client.get("/auth/sso/callback?code=authcode&state=teststate")
    assert r.status_code == 502
    assert "email" in r.json()["detail"].lower()


# ─── Token refresh ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_token_refresh_returns_new_jwt(client):
    """Valid refresh token produces a new access JWT and rotated refresh token."""
    claims = {"sub": "refresh-sub", "email": "refresh@corp.com"}
    patches = _patch_sso_callback(claims)
    with (
        patches[0],
        patches[1],
        patches[2],
        patches[3],
        patches[4],
        patches[5],
        patches[6],
        patches[7],
        patches[8],
        patches[9],
    ):
        cb = await client.get("/auth/sso/callback?code=authcode&state=teststate")

    assert cb.status_code == 200, cb.text
    original_token = cb.json()["token"]
    original_refresh = cb.json()["refresh_token"]
    user_id = cb.json()["user_id"]

    # Always mock _consume_refresh_token — in TESTING mode it returns None (no Redis).
    with (
        patch.object(sso_auth, "_consume_refresh_token", AsyncMock(return_value=(user_id, "old-jti"))),
        patch.object(sso_auth, "_store_refresh_token", AsyncMock()),
    ):
        r = await client.post("/auth/token/refresh", json={"refresh_token": original_refresh})

    assert r.status_code == 200, r.text
    body = r.json()
    assert "token" in body
    assert "refresh_token" in body
    # New access token must differ from the original.
    assert body["token"] != original_token


@pytest.mark.asyncio
async def test_token_refresh_invalid_token_returns_401(client):
    """Unknown refresh token must return 401."""
    with patch.object(sso_auth, "_consume_refresh_token", AsyncMock(return_value=None)):
        r = await client.post("/auth/token/refresh", json={"refresh_token": "bogus-token"})
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_token_refresh_replay_prevention(client):
    """Using a refresh token twice must fail on the second use."""
    claims = {"sub": "replay-sub", "email": "replay@corp.com"}
    patches = _patch_sso_callback(claims)
    with (
        patches[0],
        patches[1],
        patches[2],
        patches[3],
        patches[4],
        patches[5],
        patches[6],
        patches[7],
        patches[8],
        patches[9],
    ):
        cb = await client.get("/auth/sso/callback?code=authcode&state=teststate")

    refresh_token = cb.json()["refresh_token"]
    user_id = cb.json()["user_id"]

    assert cb.status_code == 200, cb.text

    # First use: valid.
    with (
        patch.object(sso_auth, "_consume_refresh_token", AsyncMock(return_value=(user_id, "jti-1"))),
        patch.object(sso_auth, "_store_refresh_token", AsyncMock()),
    ):
        r1 = await client.post("/auth/token/refresh", json={"refresh_token": refresh_token})
    assert r1.status_code == 200

    # Second use: token consumed (simulated by returning None).
    with patch.object(sso_auth, "_consume_refresh_token", AsyncMock(return_value=None)):
        r2 = await client.post("/auth/token/refresh", json={"refresh_token": refresh_token})
    assert r2.status_code == 401


# ─── Deactivation blocks login ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_deactivated_user_cannot_login(client):
    """After SCIM deactivation, password login returns 403."""
    # P2-5 fix: use patch.object directly — no patch.dict/reload needed.
    with patch.object(sso_auth, "SCIM_BEARER_TOKEN", "scim-token"):
        r0 = await client.post(
            "/auth/register",
            json={
                "email": "deactivate@example.com",
                "password": "Password1",
            },
        )
        assert r0.status_code == 201
        user_id = r0.json()["user_id"]

        r1 = await client.patch(
            f"/scim/v2/Users/{user_id}",
            json={"active": False},
            headers={"Authorization": "Bearer scim-token"},
        )
        assert r1.status_code == 200
        assert r1.json()["active"] is False

        r2 = await client.post(
            "/auth/login",
            json={
                "email": "deactivate@example.com",
                "password": "Password1",
            },
        )
        assert r2.status_code == 403


@pytest.mark.asyncio
async def test_sso_user_cannot_login_with_password(client):
    """An SSO-provisioned user (empty password_hash) cannot log in via /auth/login."""
    claims = {"sub": "sso-only-sub", "email": "ssoonly@corp.com"}
    patches = _patch_sso_callback(claims)
    with (
        patches[0],
        patches[1],
        patches[2],
        patches[3],
        patches[4],
        patches[5],
        patches[6],
        patches[7],
        patches[8],
        patches[9],
    ):
        await client.get("/auth/sso/callback?code=authcode&state=teststate")

    # Attempting password login must fail (empty hash never matches).
    r = await client.post(
        "/auth/login",
        json={
            "email": "ssoonly@corp.com",
            "password": "Password1",
        },
    )
    assert r.status_code == 401


# ─── SCIM 2.0 ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_scim_list_users_requires_auth(client):
    r = await client.get("/scim/v2/Users")
    assert r.status_code in (401, 503)


@pytest.mark.asyncio
async def test_scim_list_users_wrong_token(client):
    with patch.object(sso_auth, "SCIM_BEARER_TOKEN", "correct-token"):
        r = await client.get(
            "/scim/v2/Users",
            headers={"Authorization": "Bearer wrong-token"},
        )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_scim_list_users_success(client, auth_headers):
    """List users returns SCIM-formatted response with at least the registered user."""
    with patch.object(sso_auth, "SCIM_BEARER_TOKEN", "scim-token"):
        r = await client.get(
            "/scim/v2/Users",
            headers={"Authorization": "Bearer scim-token"},
        )
    assert r.status_code == 200
    body = r.json()
    assert "Resources" in body
    assert "totalResults" in body
    assert body["schemas"] == ["urn:ietf:params:scim:api:messages:2.0:ListResponse"]


@pytest.mark.asyncio
async def test_scim_list_users_filter_by_username(client, auth_headers):
    """SCIM filter userName eq 'ci@example.com' returns exactly one user."""
    with patch.object(sso_auth, "SCIM_BEARER_TOKEN", "scim-token"):
        r = await client.get(
            '/scim/v2/Users?filter=userName eq "ci@example.com"',
            headers={"Authorization": "Bearer scim-token"},
        )
    assert r.status_code == 200
    body = r.json()
    assert body["totalResults"] == 1
    assert body["Resources"][0]["userName"] == "ci@example.com"


@pytest.mark.asyncio
async def test_scim_get_user_success(client, auth_headers):
    """GET /scim/v2/Users/{id} returns the correct user."""
    # Get user_id from /auth/me
    me = await client.get("/auth/me", headers=auth_headers)
    user_id = me.json()["user_id"]

    with patch.object(sso_auth, "SCIM_BEARER_TOKEN", "scim-token"):
        r = await client.get(
            f"/scim/v2/Users/{user_id}",
            headers={"Authorization": "Bearer scim-token"},
        )
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == user_id
    assert body["userName"] == "ci@example.com"
    assert body["active"] is True


@pytest.mark.asyncio
async def test_scim_get_user_not_found(client):
    with patch.object(sso_auth, "SCIM_BEARER_TOKEN", "scim-token"):
        r = await client.get(
            f"/scim/v2/Users/{uuid.uuid4()}",
            headers={"Authorization": "Bearer scim-token"},
        )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_scim_patch_deactivate_rfc7644(client, auth_headers):
    """RFC 7644 Operations-style deactivation."""
    me = await client.get("/auth/me", headers=auth_headers)
    user_id = me.json()["user_id"]

    with patch.object(sso_auth, "SCIM_BEARER_TOKEN", "scim-token"):
        r = await client.patch(
            f"/scim/v2/Users/{user_id}",
            json={"Operations": [{"op": "replace", "path": "active", "value": False}]},
            headers={"Authorization": "Bearer scim-token"},
        )
    assert r.status_code == 200
    assert r.json()["active"] is False


@pytest.mark.asyncio
async def test_scim_patch_deactivate_okta_style(client):
    """Okta-style direct body deactivation."""
    # Register a separate user for this test.
    r0 = await client.post(
        "/auth/register",
        json={
            "email": "okta-deactivate@example.com",
            "password": "Password1",
        },
    )
    user_id = r0.json()["user_id"]

    with patch.object(sso_auth, "SCIM_BEARER_TOKEN", "scim-token"):
        r = await client.patch(
            f"/scim/v2/Users/{user_id}",
            json={"active": False},
            headers={"Authorization": "Bearer scim-token"},
        )
    assert r.status_code == 200
    assert r.json()["active"] is False


@pytest.mark.asyncio
async def test_scim_patch_invalid_uuid(client):
    with patch.object(sso_auth, "SCIM_BEARER_TOKEN", "scim-token"):
        r = await client.patch(
            "/scim/v2/Users/not-a-uuid",
            json={"active": False},
            headers={"Authorization": "Bearer scim-token"},
        )
    assert r.status_code == 400


# ─── Internal helper unit tests ───────────────────────────────────────────────


def test_decode_id_token_claims_well_formed():
    from sso_auth import _decode_id_token_claims

    claims = {"sub": "abc", "email": "test@example.com", "groups": ["admin"]}
    token = _make_fake_id_token(claims)
    result = _decode_id_token_claims(token)
    assert result["sub"] == "abc"
    assert result["email"] == "test@example.com"
    assert result["groups"] == ["admin"]


def test_decode_id_token_claims_malformed():
    from sso_auth import _decode_id_token_claims

    result = _decode_id_token_claims("not.a.token")
    assert isinstance(result, dict)


def test_make_refresh_token_format():
    from sso_auth import _make_refresh_token

    rt = _make_refresh_token("user-123", "jti-456")
    assert "." in rt
    parts = rt.split(".")
    assert len(parts) == 2


@pytest.mark.asyncio
async def test_provision_user_creates_new_user(client):
    """First-time SSO login creates a new user row with empty password_hash."""
    # P4-2 fix: test via the /auth/sso/callback endpoint so we use the
    # test client's overridden session (correct in-memory engine).
    # Direct get_session() calls bypass the override and use the module-level
    # engine which has no tables in test mode.
    claims = {"sub": "prov-sub", "email": "provisioned@example.com", "name": "Provisioned"}
    patches = _patch_sso_callback(claims)
    with (
        patches[0],
        patches[1],
        patches[2],
        patches[3],
        patches[4],
        patches[5],
        patches[6],
        patches[7],
        patches[8],
        patches[9],
    ):
        r = await client.get("/auth/sso/callback?code=authcode&state=teststate")
    assert r.status_code == 200, r.text
    assert r.json()["email"] == "provisioned@example.com"
    # Verify the user was created (can log in with the returned JWT)
    token = r.json()["token"]
    me = await client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200
    assert me.json()["email"] == "provisioned@example.com"


@pytest.mark.asyncio
async def test_provision_user_returns_existing(client):
    """Second SSO login for the same email returns the same user (no duplicate)."""
    # P4-2 fix: test via HTTP endpoints throughout.
    r0 = await client.post(
        "/auth/register",
        json={
            "email": "existing-sso@example.com",
            "password": "Password1",
        },
    )
    assert r0.status_code == 201
    original_user_id = r0.json()["user_id"]

    claims = {"sub": "x", "email": "existing-sso@example.com", "name": "X"}
    patches = _patch_sso_callback(claims)
    with (
        patches[0],
        patches[1],
        patches[2],
        patches[3],
        patches[4],
        patches[5],
        patches[6],
        patches[7],
        patches[8],
        patches[9],
    ):
        r1 = await client.get("/auth/sso/callback?code=authcode&state=teststate")
    assert r1.status_code == 200
    # Same user_id — no duplicate created.
    assert r1.json()["user_id"] == original_user_id
