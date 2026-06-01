"""
Tests for POST /auth/logout and jti-based token revocation.

In the test suite (TESTING=true), redis_client operations are no-ops so no
running Redis is required.  What we test here:
  - /auth/logout returns 204 for a valid token
  - /auth/logout returns 204 for an invalid token (no info leak)
  - jti field is present in register and login responses
  - /auth/me still works after logout IN TEST MODE (revocation is skipped
    so we verify the API contract, not the Redis integration)
  - The REDIS_URL / revoke_token path is unit-tested separately
"""

import pytest


@pytest.mark.asyncio
async def test_register_includes_jti(client):
    resp = await client.post(
        "/auth/register",
        json={
            "email": "jti@example.com",
            "password": "Password1",
        },
    )
    assert resp.status_code == 201
    body = resp.json()
    assert "jti" in body
    assert len(body["jti"]) == 36  # UUID4 string


@pytest.mark.asyncio
async def test_login_includes_jti(client):
    await client.post(
        "/auth/register",
        json={
            "email": "jti2@example.com",
            "password": "Password1",
        },
    )
    resp = await client.post(
        "/auth/login",
        json={
            "email": "jti2@example.com",
            "password": "Password1",
        },
    )
    assert resp.status_code == 200
    assert "jti" in resp.json()


@pytest.mark.asyncio
async def test_logout_returns_204(client, auth_headers):
    resp = await client.post("/auth/logout", headers=auth_headers)
    assert resp.status_code == 204


@pytest.mark.asyncio
async def test_logout_with_invalid_token_returns_204(client):
    """Logout must not expose whether a jti exists in the blocklist."""
    resp = await client.post(
        "/auth/logout",
        headers={"Authorization": "Bearer not.a.valid.token"},
    )
    assert resp.status_code == 204


@pytest.mark.asyncio
async def test_logout_without_token_returns_401(client):
    """HTTPBearer rejects missing auth before the logout handler runs.
    FastAPI 0.115+ changed HTTPBearer to return 401 for missing credentials."""
    resp = await client.post("/auth/logout")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_me_still_works_in_test_mode_after_logout(client, auth_headers):
    """In TESTING=true, revocation is a no-op so /me still succeeds.

    This verifies the API contract: we test real revocation integration
    separately (see test_redis_revocation.py for a live-Redis test).
    """
    await client.post("/auth/logout", headers=auth_headers)
    resp = await client.get("/auth/me", headers=auth_headers)
    # In test mode, the jti check is skipped — token is still valid.
    assert resp.status_code == 200
    assert "email" in resp.json()
