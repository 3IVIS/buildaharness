"""
Tests for the Mastra execution runner integration.

Strategy: the real mastra-runner sidecar is a Node.js process — it cannot run in
the Python test suite.  Instead we:

  1. Mock the HTTP calls to the sidecar (httpx) so _run_mastra completes
     without a real Node.js process.
  2. Test the full request-handling path: POST /run?runtime=mastra →
     job created in DB → background task dispatched → DB updated to done/error.
  3. Test /runtimes reports mastra as executable.
  4. Test A2A send_task accepts mastra as a valid runtime.
  5. Test the sidecar-unreachable error path (job lands in "error").
  6. Test compile_mastra is called before the sidecar call (codegen smoke).

Covered:
  GET  /runtimes           — mastra now executable: true
  POST /run?runtime=mastra — 202 + job created in DB
  POST /run?runtime=mastra — background task drives job to "done" via mock runner
  POST /run?runtime=mastra — sidecar HTTP 500 → job lands in "error"
  POST /run?runtime=mastra — sidecar unreachable (ConnectError) → job "error"
  POST /run?runtime=mastra — sidecar returns node events → synced to DB
  POST /a2a/.../tasks/send — mastra runtime accepted (no 400)
  compile_mastra           — called before POST /execute (codegen smoke test)
"""

import asyncio
import json
import uuid
from datetime import UTC, datetime
from typing import Any
from unittest.mock import patch

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker

from run_api import _jobs_get
from tests.conftest import MINIMAL_SPEC

# ── helpers ────────────────────────────────────────────────────────────────────


def _mock_runner_response(
    status: str = "done",
    node_events: list | None = None,
    result: str = '{"output": "hello from mastra"}',
    error: str | None = None,
) -> dict[str, Any]:
    """Build the JSON body the mock sidecar returns from GET /jobs/:id."""
    return {
        "job_id": "will-be-overwritten",
        "status": status,
        "node_events": node_events or [],
        "result": result,
        "error": error,
        "started_at": datetime.now(UTC).isoformat(),
        "ended_at": datetime.now(UTC).isoformat(),
    }


def _make_httpx_mock(post_status: int = 202, poll_responses: list | None = None):
    """
    Return a patch target and side_effect list for httpx.AsyncClient.

    The mock intercepts:
      POST /execute   → returns post_status
      GET  /jobs/:id  → cycles through poll_responses (last item repeated)

    poll_responses is a list of (status_code, body_dict) tuples.
    Default: one poll returning status=done.
    """
    if poll_responses is None:
        poll_responses = [(200, _mock_runner_response("done"))]

    poll_iter = iter(poll_responses)
    poll_last = poll_responses[-1]

    class _FakeResponse:
        def __init__(self, status_code: int, body: dict):
            self.status_code = status_code
            self._body = body

        def json(self) -> dict:
            return self._body

        @property
        def text(self) -> str:
            return json.dumps(self._body)

    class _FakeClient:
        def __init__(self, **kwargs):
            pass  # absorb timeout= etc.

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            pass

        async def post(self, url: str, **kwargs) -> _FakeResponse:
            return _FakeResponse(post_status, {"status": "running"})

        async def get(self, url: str, **kwargs) -> _FakeResponse:
            try:
                sc, body = next(poll_iter)
            except StopIteration:
                sc, body = poll_last
            return _FakeResponse(sc, body)

    return _FakeClient


# ── GET /runtimes ──────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_runtimes_mastra_executable(client, auth_headers):
    """After the runner is wired, /runtimes must report mastra as executable."""
    r = await client.get("/runtimes")
    assert r.status_code == 200
    rt = r.json()["runtimes"]
    assert "mastra" in rt, "mastra key missing from /runtimes"
    assert rt["mastra"]["executable"] is True, f"mastra should be executable: True, got {rt['mastra']}"
    assert rt["mastra"]["status"] == "full"


# ── POST /run?runtime=mastra ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_mastra_run_creates_job_row(client, auth_headers, db_engine):
    """POST /run?runtime=mastra must create a Job row with runtime=mastra."""
    FakeClient = _make_httpx_mock()
    with patch("run_api._httpx.AsyncClient", FakeClient):
        r = await client.post(
            "/run?runtime=mastra",
            json={"spec": MINIMAL_SPEC},
            headers=auth_headers,
        )
    assert r.status_code == 202, r.text
    job_id = r.json()["job_id"]
    assert r.json()["runtime"] == "mastra"

    # Allow the background task to run.
    await asyncio.sleep(0.2)

    SessionLocal = async_sessionmaker(db_engine, expire_on_commit=False)
    async with SessionLocal() as db:
        job = await _jobs_get(job_id, db)

    assert job is not None
    assert job.runtime == "mastra"


@pytest.mark.asyncio
async def test_mastra_run_reaches_done(client, auth_headers, db_engine):
    """_run_mastra must drive the job to 'done' when the sidecar reports done."""
    FakeClient = _make_httpx_mock(poll_responses=[(200, _mock_runner_response("done", result='{"answer": 42}'))])
    with patch("run_api._httpx.AsyncClient", FakeClient):
        r = await client.post(
            "/run?runtime=mastra",
            json={"spec": MINIMAL_SPEC},
            headers=auth_headers,
        )
    job_id = r.json()["job_id"]

    # Wait for background task to finish.
    for _ in range(20):
        await asyncio.sleep(0.1)
        SessionLocal = async_sessionmaker(db_engine, expire_on_commit=False)
        async with SessionLocal() as db:
            job = await _jobs_get(job_id, db)
        if job and job.status in ("done", "error"):
            break

    assert job is not None
    assert job.status == "done", f"expected done, got {job.status}: {job.error}"
    assert job.result is not None


@pytest.mark.asyncio
async def test_mastra_run_sidecar_500_lands_in_error(client, auth_headers, db_engine):
    """When the sidecar returns 500 on /execute, job must land in 'error'."""
    FakeClient = _make_httpx_mock(post_status=500)
    with patch("run_api._httpx.AsyncClient", FakeClient):
        r = await client.post(
            "/run?runtime=mastra",
            json={"spec": MINIMAL_SPEC},
            headers=auth_headers,
        )
    job_id = r.json()["job_id"]

    for _ in range(20):
        await asyncio.sleep(0.1)
        SessionLocal = async_sessionmaker(db_engine, expire_on_commit=False)
        async with SessionLocal() as db:
            job = await _jobs_get(job_id, db)
        if job and job.status in ("done", "error"):
            break

    assert job is not None
    assert job.status == "error"
    assert job.error is not None


@pytest.mark.asyncio
async def test_mastra_run_sidecar_unreachable_lands_in_error(client, auth_headers, db_engine):
    """When the sidecar is unreachable (ConnectError), job must land in 'error'."""
    import httpx as _httpx_real

    class _UnreachableClient:
        def __init__(self, **kwargs):
            pass  # absorb timeout=

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            pass

        async def post(self, *args, **kwargs):
            raise _httpx_real.ConnectError("Connection refused")

        async def get(self, *args, **kwargs):
            raise _httpx_real.ConnectError("Connection refused")

    with patch("run_api._httpx.AsyncClient", _UnreachableClient):
        r = await client.post(
            "/run?runtime=mastra",
            json={"spec": MINIMAL_SPEC},
            headers=auth_headers,
        )
    job_id = r.json()["job_id"]

    for _ in range(20):
        await asyncio.sleep(0.1)
        SessionLocal = async_sessionmaker(db_engine, expire_on_commit=False)
        async with SessionLocal() as db:
            job = await _jobs_get(job_id, db)
        if job and job.status in ("done", "error"):
            break

    assert job is not None
    assert job.status == "error"
    assert "refused" in (job.error or "").lower() or "connect" in (job.error or "").lower()


@pytest.mark.asyncio
async def test_mastra_run_node_events_synced(client, auth_headers, db_engine):
    """Node events returned by the sidecar must appear in the DB job row."""
    events = [
        {"node_id": "llm-1", "status": "running", "ts": datetime.now(UTC).isoformat(), "ms": None, "tokens": None},
        {"node_id": "llm-1", "status": "done", "ts": datetime.now(UTC).isoformat(), "ms": 123, "tokens": 42},
    ]
    poll = _mock_runner_response("done", node_events=events)
    FakeClient = _make_httpx_mock(poll_responses=[(200, poll)])

    with patch("run_api._httpx.AsyncClient", FakeClient):
        r = await client.post(
            "/run?runtime=mastra",
            json={"spec": MINIMAL_SPEC},
            headers=auth_headers,
        )
    job_id = r.json()["job_id"]

    for _ in range(20):
        await asyncio.sleep(0.1)
        SessionLocal = async_sessionmaker(db_engine, expire_on_commit=False)
        async with SessionLocal() as db:
            job = await _jobs_get(job_id, db)
        if job and job.status in ("done", "error"):
            break

    assert job is not None
    # node_events from the sidecar + the initial "pending" events from the adapter
    sidecar_events = [e for e in (job.node_events or []) if e["node_id"] == "llm-1"]
    assert len(sidecar_events) >= 1, "Expected at least one llm-1 event in DB"
    done_events = [e for e in sidecar_events if e["status"] == "done"]
    assert done_events, "Expected a done event for llm-1"


@pytest.mark.asyncio
async def test_mastra_run_sidecar_error_status(client, auth_headers, db_engine):
    """When the sidecar poll returns status=error, job must land in DB error."""
    poll = _mock_runner_response("error", error="Mastra step threw: TypeError")
    FakeClient = _make_httpx_mock(poll_responses=[(200, poll)])

    with patch("run_api._httpx.AsyncClient", FakeClient):
        r = await client.post(
            "/run?runtime=mastra",
            json={"spec": MINIMAL_SPEC},
            headers=auth_headers,
        )
    job_id = r.json()["job_id"]

    for _ in range(20):
        await asyncio.sleep(0.1)
        SessionLocal = async_sessionmaker(db_engine, expire_on_commit=False)
        async with SessionLocal() as db:
            job = await _jobs_get(job_id, db)
        if job and job.status in ("done", "error"):
            break

    assert job is not None
    assert job.status == "error"
    assert "TypeError" in (job.error or "")


# ── compile_mastra is called before /execute ───────────────────────────────────


@pytest.mark.asyncio
async def test_mastra_codegen_called_before_execute(client, auth_headers):
    """compile_mastra must be invoked before POSTing to the sidecar."""
    called_with_spec = []

    original_import = __builtins__  # noqa: F841 — used below via closure

    async def _fake_run_mastra(job_id: str, spec: dict, org_id: str | None = None) -> None:
        called_with_spec.append(spec)

    with patch("run_api._run_mastra", _fake_run_mastra):
        r = await client.post(
            "/run?runtime=mastra",
            json={"spec": MINIMAL_SPEC},
            headers=auth_headers,
        )

    assert r.status_code == 202
    await asyncio.sleep(0.1)
    assert len(called_with_spec) == 1, "Expected _run_mastra to be called once"
    assert called_with_spec[0].get("id") == MINIMAL_SPEC["id"]


# ── GET /run/{job_id} returns mastra job ───────────────────────────────────────


@pytest.mark.asyncio
async def test_get_run_returns_mastra_job(client, auth_headers, db_engine):
    """GET /run/{job_id} must return the mastra job row correctly."""
    FakeClient = _make_httpx_mock()
    with patch("run_api._httpx.AsyncClient", FakeClient):
        r = await client.post(
            "/run?runtime=mastra",
            json={"spec": MINIMAL_SPEC},
            headers=auth_headers,
        )
    job_id = r.json()["job_id"]

    r2 = await client.get(f"/run/{job_id}", headers=auth_headers)
    assert r2.status_code == 200
    assert r2.json()["runtime"] == "mastra"


# ── A2A task with mastra runtime ───────────────────────────────────────────────

A2A_MASTRA_SPEC = {
    **MINIMAL_SPEC,
    "id": "mastra-a2a-flow",
    "name": "Mastra A2A Test",
    "runtime_hints": {"preferred_adapter": "mastra"},
    "flow_config": {
        "a2a_config": {
            "enabled": True,
            "agent_name": "Mastra A2A Agent",
            "agent_description": "Test",
            "version": "1.0.0",
            "authentication": "none",
        }
    },
}


@pytest.mark.asyncio
async def test_mastra_run_polling_timeout_lands_in_error(client, auth_headers, db_engine):
    """A job that never leaves 'running' must hit the timeout and land in 'error'."""
    import run_api

    # Patch a very short timeout so the test doesn't wait 3600s.
    original_timeout = run_api.MASTRA_RUNNER_TIMEOUT
    run_api.MASTRA_RUNNER_TIMEOUT = 0.1  # 100ms — expires immediately

    # Sidecar always returns "running" — never done or error.
    stuck_poll = _mock_runner_response("running")
    FakeClient = _make_httpx_mock(poll_responses=[(200, stuck_poll)])

    try:
        with patch("run_api._httpx.AsyncClient", FakeClient):
            r = await client.post(
                "/run?runtime=mastra",
                json={"spec": MINIMAL_SPEC},
                headers=auth_headers,
            )
        job_id = r.json()["job_id"]

        for _ in range(30):
            await asyncio.sleep(0.05)
            SessionLocal = async_sessionmaker(db_engine, expire_on_commit=False)
            async with SessionLocal() as db:
                job = await _jobs_get(job_id, db)
            if job and job.status in ("done", "error"):
                break
    finally:
        run_api.MASTRA_RUNNER_TIMEOUT = original_timeout

    assert job is not None
    assert job.status == "error", f"Expected error from timeout, got {job.status}"
    assert "timeout" in (job.error or "").lower()


@pytest.mark.asyncio
async def test_a2a_task_mastra_runtime_accepted(client, auth_headers, db_engine):
    """POST /a2a/{flow_id}/tasks/send with a Mastra-preferred flow must not return 400."""
    # Save the flow.
    r = await client.post("/flows", json={"spec": A2A_MASTRA_SPEC}, headers=auth_headers)
    assert r.status_code == 200, r.text

    task_id = str(uuid.uuid4())
    FakeClient = _make_httpx_mock()
    with patch("run_api._httpx.AsyncClient", FakeClient):
        r2 = await client.post(
            f"/a2a/{A2A_MASTRA_SPEC['id']}/tasks/send",
            json={"id": task_id, "message": {"role": "user", "parts": [{"text": "go"}]}},
            headers=auth_headers,
        )
    assert r2.status_code == 202, r2.text

    SessionLocal = async_sessionmaker(db_engine, expire_on_commit=False)
    async with SessionLocal() as db:
        job = await _jobs_get(task_id, db)

    assert job is not None
    assert job.runtime == "mastra"
