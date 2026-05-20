"""
Tests for the Postgres-backed job store (migration 0004).

Covered:
  POST /run          — queued job row created in DB
  GET  /run/{id}     — returns correct status from DB
  POST /run          — WEB_CONCURRENCY > 1 no longer raises FATAL
  TTL eviction       — _evict_stale_jobs deletes old done/error rows
  Persistence        — job row survives simulated app restart
                       (new client, same DB engine)
  Isolation          — a second user cannot see another user's jobs
  Auth guard         — 404 for missing job_id
  Auth guard         — 401 for unauthenticated request
  A2A task           — POST /a2a/{flow_id}/tasks/send creates a DB row
  A2A task           — GET  /a2a/{flow_id}/tasks/{task_id} reads from DB
  A2A duplicate      — 409 on duplicate task_id
"""
import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

# conftest already sets TESTING=true and DATABASE_URL before any import.
from tests.conftest import MINIMAL_SPEC
from db import Job, get_session
from run_api import _evict_stale_jobs, _jobs_create, _jobs_get
from main import app


# ── helpers ───────────────────────────────────────────────────────────────────

async def _register_and_login(client: AsyncClient, email: str = "ci@example.com") -> dict:
    r = await client.post("/auth/register", json={"email": email, "password": "Password1"})
    assert r.status_code == 201, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


A2A_SPEC = {
    **MINIMAL_SPEC,
    "id": "a2a-job-store-flow",
    "name": "A2A Job Store Test",
    "flow_config": {
        "a2a_config": {
            "enabled":           True,
            "agent_name":        "Store Test Agent",
            "agent_description": "Tests the job store",
            "version":           "1.0.0",
            "authentication":    "none",
        }
    },
}


# ── basic CRUD ────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_run_creates_job_row(client, auth_headers, db_engine):
    """POST /run should insert a Job row in the database."""
    r = await client.post(
        "/run?runtime=langgraph",
        json={"spec": MINIMAL_SPEC},
        headers=auth_headers,
    )
    assert r.status_code == 202, r.text
    job_id = r.json()["job_id"]

    SessionLocal = async_sessionmaker(db_engine, expire_on_commit=False)
    async with SessionLocal() as db:
        job = await _jobs_get(job_id, db)

    assert job is not None, "Job row must exist in DB after POST /run"
    assert job.runtime == "langgraph"
    assert job.status in ("queued", "running", "done", "error")


@pytest.mark.asyncio
async def test_get_run_reads_from_db(client, auth_headers, db_engine):
    """GET /run/{job_id} must return data sourced from the DB row."""
    r = await client.post(
        "/run?runtime=langgraph",
        json={"spec": MINIMAL_SPEC},
        headers=auth_headers,
    )
    assert r.status_code == 202, r.text
    job_id = r.json()["job_id"]

    r2 = await client.get(f"/run/{job_id}", headers=auth_headers)
    assert r2.status_code == 200, r2.text
    body = r2.json()
    assert body["job_id"] == job_id
    assert body["runtime"] == "langgraph"
    assert "status" in body
    assert "node_events" in body


@pytest.mark.asyncio
async def test_job_not_found_returns_404(client, auth_headers):
    """GET /run/{job_id} with an unknown ID must return 404."""
    r = await client.get(f"/run/{uuid.uuid4()}", headers=auth_headers)
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_unauthenticated_run_returns_401(client):
    """GET /run/{job_id} without a token must return 401."""
    r = await client.get(f"/run/{uuid.uuid4()}")
    assert r.status_code == 401


# ── isolation ─────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_job_isolated_between_users(client, auth_headers, db_engine):
    """A second user must not be able to see the first user's job."""
    r = await client.post(
        "/run?runtime=langgraph",
        json={"spec": MINIMAL_SPEC},
        headers=auth_headers,
    )
    assert r.status_code == 202
    job_id = r.json()["job_id"]

    other_headers = await _register_and_login(client, "other2@example.com")
    r2 = await client.get(f"/run/{job_id}", headers=other_headers)
    assert r2.status_code == 404, "Other user must not see this job"


# ── WEB_CONCURRENCY guard removed ─────────────────────────────────────────────

def test_web_concurrency_guard_removed():
    """The old FATAL sys.exit guard must no longer exist in run_api.py."""
    import run_api, inspect
    src = inspect.getsource(run_api)
    assert "_sys.exit(1)" not in src, (
        "run_api.py must not crash on WEB_CONCURRENCY > 1 — the guard was "
        "only needed for the in-memory _jobs dict which is now replaced."
    )
    assert "_jobs: dict[str, dict[str, Any]]" not in src, (
        "run_api.py must not define the old in-memory _jobs dict."
    )


# ── TTL eviction ──────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_evict_stale_jobs(db_engine):
    """_evict_stale_jobs must delete done/error rows older than JOB_TTL_HOURS."""
    SessionLocal = async_sessionmaker(db_engine, expire_on_commit=False)

    # Manufacture a fake user so the FK constraint is satisfied.
    from db import User
    import bcrypt
    user_id = uuid.uuid4()
    async with SessionLocal() as db:
        from sqlalchemy import text
        # Insert a minimal user row directly.
        await db.execute(
            text(
                "INSERT INTO users (id, email, password_hash) "
                "VALUES (:id, :email, :pw)"
            ),
            {"id": str(user_id), "email": "evict-test@example.com",
             "pw": bcrypt.hashpw(b"Password1", bcrypt.gensalt()).decode()},
        )
        await db.commit()

    old_done_id  = str(uuid.uuid4())
    old_error_id = str(uuid.uuid4())
    fresh_id     = str(uuid.uuid4())
    now          = datetime.now(timezone.utc)
    old_ts       = now - timedelta(hours=5)

    async with SessionLocal() as db:
        for jid, status, ts in [
            (old_done_id,  "done",  old_ts),
            (old_error_id, "error", old_ts),
            (fresh_id,     "done",  now),
        ]:
            db.add(Job(
                id         = jid,
                user_id    = user_id,
                status     = status,
                runtime    = "langgraph",
                node_events= [],
                started_at = old_ts,
                ended_at   = ts,
                created_at = old_ts,
            ))
        await db.commit()

    async with SessionLocal() as db:
        await _evict_stale_jobs(db)

    async with SessionLocal() as db:
        remaining = (await db.execute(
            select(Job).where(Job.id.in_([old_done_id, old_error_id, fresh_id]))
        )).scalars().all()
        remaining_ids = {r.id for r in remaining}

    assert old_done_id  not in remaining_ids, "Old done job should be evicted"
    assert old_error_id not in remaining_ids, "Old error job should be evicted"
    assert fresh_id     in remaining_ids,     "Fresh job must NOT be evicted"


# ── persistence simulation ────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_job_survives_app_restart(db_engine, auth_headers):
    """Simulate a process restart: a new app client can read jobs from the old session."""
    # Create a job via the normal client.
    SessionLocal = async_sessionmaker(db_engine, expire_on_commit=False)

    async def _override():
        async with SessionLocal() as s:
            yield s

    app.dependency_overrides[get_session] = _override
    transport = ASGITransport(app=app)

    async with AsyncClient(transport=transport, base_url="http://test") as first_client:
        r = await first_client.post(
            "/run?runtime=langgraph",
            json={"spec": MINIMAL_SPEC},
            headers=auth_headers,
        )
        assert r.status_code == 202
        job_id = r.json()["job_id"]

    # Simulate "restart": new client, same DB engine.
    async with AsyncClient(transport=transport, base_url="http://test") as second_client:
        r2 = await second_client.get(f"/run/{job_id}", headers=auth_headers)
        assert r2.status_code == 200, "Job must be readable after simulated restart"
        assert r2.json()["job_id"] == job_id

    app.dependency_overrides.clear()
    app.dependency_overrides[get_session] = _override  # restore for teardown


# ── A2A task creates DB row ───────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_a2a_task_creates_job_row(client, auth_headers, db_engine):
    """POST /a2a/{flow_id}/tasks/send must insert a Job row."""
    # Save the flow first.
    r = await client.post("/flows", json={"spec": A2A_SPEC}, headers=auth_headers)
    assert r.status_code == 200, r.text

    task_id = str(uuid.uuid4())
    r2 = await client.post(
        f"/a2a/{A2A_SPEC['id']}/tasks/send",
        json={"id": task_id, "message": {"role": "user", "parts": [{"type": "text", "text": "hi"}]}},
        headers=auth_headers,
    )
    assert r2.status_code == 202, r2.text

    SessionLocal = async_sessionmaker(db_engine, expire_on_commit=False)
    async with SessionLocal() as db:
        job = await _jobs_get(task_id, db)

    assert job is not None, "A2A task must create a Job row in DB"
    assert job.id == task_id


@pytest.mark.asyncio
async def test_a2a_get_task_reads_from_db(client, auth_headers):
    """GET /a2a/{flow_id}/tasks/{task_id} must return task data from DB."""
    r = await client.post("/flows", json={"spec": A2A_SPEC}, headers=auth_headers)
    assert r.status_code == 200, r.text

    task_id = str(uuid.uuid4())
    await client.post(
        f"/a2a/{A2A_SPEC['id']}/tasks/send",
        json={"id": task_id, "message": {"role": "user", "parts": []}},
        headers=auth_headers,
    )

    r2 = await client.get(
        f"/a2a/{A2A_SPEC['id']}/tasks/{task_id}",
        headers=auth_headers,
    )
    assert r2.status_code == 200, r2.text
    body = r2.json()
    assert body["id"] == task_id
    assert "status" in body


@pytest.mark.asyncio
async def test_a2a_duplicate_task_id_returns_409(client, auth_headers):
    """Sending the same task_id twice must return 409."""
    r = await client.post("/flows", json={"spec": A2A_SPEC}, headers=auth_headers)
    assert r.status_code == 200, r.text

    task_id = str(uuid.uuid4())
    payload = {"id": task_id, "message": {"role": "user", "parts": []}}

    r1 = await client.post(
        f"/a2a/{A2A_SPEC['id']}/tasks/send", json=payload, headers=auth_headers
    )
    assert r1.status_code == 202

    r2 = await client.post(
        f"/a2a/{A2A_SPEC['id']}/tasks/send", json=payload, headers=auth_headers
    )
    assert r2.status_code == 409, "Duplicate task_id must return 409"
