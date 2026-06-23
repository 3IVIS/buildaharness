"""
Shared pytest fixtures for the buildaharness adapter test suite.

Uses an in-memory SQLite database so no Postgres is required in CI.
JWT_SECRET and DATABASE_URL are set before any adapter module is imported
so the startup guards in main.py and db.py don't exit(1).
"""

import os

import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

# ── Set required env vars BEFORE importing any adapter module ─────────────────
os.environ.setdefault("JWT_SECRET", "test-secret-for-ci-only-not-production")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("WEB_CONCURRENCY", "1")
# Disable shared rate-limit buckets so the 5/min register cap never fires in CI.
os.environ.setdefault("TESTING", "true")
# Speed up Mastra polling in tests so background tasks resolve immediately.
os.environ.setdefault("MASTRA_POLL_INTERVAL_S", "0")

# Now safe to import
import run_api as _run_api
from db import Base, get_session
from main import app


@pytest_asyncio.fixture(scope="function")
async def db_engine():
    """Fresh in-memory SQLite engine + tables per test."""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    await engine.dispose()


@pytest_asyncio.fixture(scope="function")
async def client(db_engine):
    """
    AsyncClient wired to the FastAPI app, with the DB overridden to use the
    per-test in-memory engine so tests are fully isolated.
    """
    SessionLocal = async_sessionmaker(db_engine, expire_on_commit=False)

    async def _override_session():
        async with SessionLocal() as session:
            yield session

    app.dependency_overrides[get_session] = _override_session

    # Wire the background-task session factory to the same per-test engine so
    # that background runners (run_api._job_session) write to the same DB that
    # the test client reads from.
    _run_api.configure_bg_session(SessionLocal)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac

    app.dependency_overrides.clear()


@pytest_asyncio.fixture(scope="function")
async def auth_headers(client):
    """Register a user and return Bearer headers for authenticated requests."""
    resp = await client.post(
        "/auth/register",
        json={
            "email": "ci@example.com",
            "password": "Password1",
        },
    )
    assert resp.status_code == 201, resp.text
    token = resp.json()["token"]
    return {"Authorization": f"Bearer {token}"}


# ── Minimal valid flow spec ────────────────────────────────────────────────────

MINIMAL_SPEC = {
    "spec_version": "0.2.0",
    "id": "test-flow",
    "name": "Test Flow",
    "nodes": [
        {"id": "input-1", "type": "input", "position": {"x": 0, "y": 0}},
        {"id": "output-1", "type": "output", "position": {"x": 300, "y": 0}},
    ],
    "edges": [
        {"id": "e1", "type": "direct", "from": "input-1", "to": "output-1"},
    ],
}
