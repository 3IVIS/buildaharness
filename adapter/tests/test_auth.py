"""
Tests for /auth/register, /auth/login, /auth/me
"""
import pytest
from tests.conftest import MINIMAL_SPEC


@pytest.mark.asyncio
async def test_register_success(client):
    resp = await client.post("/auth/register", json={
        "email": "new@example.com", "password": "Password1",
    })
    assert resp.status_code == 201
    body = resp.json()
    assert "token" in body
    assert body["email"] == "new@example.com"


@pytest.mark.asyncio
async def test_register_duplicate_email(client):
    payload = {"email": "dup@example.com", "password": "Password1"}
    r1 = await client.post("/auth/register", json=payload)
    assert r1.status_code == 201
    r2 = await client.post("/auth/register", json=payload)
    assert r2.status_code == 409
    assert "already registered" in r2.json()["detail"]


@pytest.mark.asyncio
@pytest.mark.parametrize("password,reason", [
    ("short1",       "too short"),
    ("alllowercase", "no digit"),
    ("12345678",     "no letter"),
    ("",             "empty"),
])
async def test_register_password_policy(client, password, reason):
    resp = await client.post("/auth/register", json={
        "email": f"test-{reason.replace(' ', '')}@example.com",
        "password": password,
    })
    assert resp.status_code == 400, f"Expected 400 for password policy ({reason})"


@pytest.mark.asyncio
async def test_register_invalid_email(client):
    resp = await client.post("/auth/register", json={
        "email": "not-an-email", "password": "Password1",
    })
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_login_success(client):
    await client.post("/auth/register", json={
        "email": "login@example.com", "password": "Password1",
    })
    resp = await client.post("/auth/login", json={
        "email": "login@example.com", "password": "Password1",
    })
    assert resp.status_code == 200
    assert "token" in resp.json()


@pytest.mark.asyncio
async def test_login_wrong_password(client):
    await client.post("/auth/register", json={
        "email": "wrongpw@example.com", "password": "Password1",
    })
    resp = await client.post("/auth/login", json={
        "email": "wrongpw@example.com", "password": "WrongPass9",
    })
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_login_unknown_email(client):
    """Should still return 401, not 404 — prevents user enumeration."""
    resp = await client.post("/auth/login", json={
        "email": "ghost@example.com", "password": "Password1",
    })
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_me_authenticated(client, auth_headers):
    resp = await client.get("/auth/me", headers=auth_headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["email"] == "ci@example.com"
    assert "user_id" in body


@pytest.mark.asyncio
async def test_me_unauthenticated(client):
    resp = await client.get("/auth/me")
    assert resp.status_code == 401  # FastAPI 0.115+: HTTPBearer returns 401 when no token


@pytest.mark.asyncio
async def test_me_invalid_token(client):
    resp = await client.get("/auth/me", headers={"Authorization": "Bearer garbage"})
    assert resp.status_code == 401
