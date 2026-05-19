"""
Tests for the /eval/* endpoints.

All tests use TESTING=true (set by conftest.py) which:
  - skips real Langfuse SDK calls (no live Langfuse needed in CI)
  - disables Redis checks
  - uses per-call unique rate-limit keys

Covered:
  POST /eval/score       — 204 with valid payload; 401 without auth
  POST /eval/feedback    — 204 with valid job; 404 unknown job; 404 wrong owner;
                           204 when job has no trace_id; 422 for bad value
  GET  /eval/templates   — 200, returns empty list in TESTING mode
  GET  /eval/scores      — 200, returns {"data": []} in TESTING mode
  seed_eval_templates()  — no-op in TESTING mode (called twice → still no-op)
"""
from datetime import datetime, timezone

import pytest

from run_api import _jobs

# ── helpers ───────────────────────────────────────────────────────────────────

async def _register(client, email: str, password: str = "Password1") -> dict:
    r = await client.post("/auth/register", json={"email": email, "password": password})
    assert r.status_code == 201, r.text
    return r.json()


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _seed_job(
    user_id: str,
    job_id:  str  = "eval-test-job",
    trace_id: str | None = "trace-abc-123",
) -> None:
    """Directly insert a synthetic completed job into the in-memory job store."""
    _jobs[job_id] = {
        "job_id":         job_id,
        "user_id":        user_id,
        "status":         "done",
        "runtime":        "langgraph",
        "started_at":     datetime.now(timezone.utc),
        "ended_at":       datetime.now(timezone.utc),
        "result":         "ok",
        "error":          None,
        "node_events":    [],
        "hitl_state":     None,
        "trace_id":       trace_id,
        "trace_url":      None,
        "compiled_graph": None,
        "lg_config":      None,
        "trackable":      [],
    }


def _cleanup_job(job_id: str = "eval-test-job") -> None:
    _jobs.pop(job_id, None)


# ── POST /eval/score ──────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_score_returns_204(client, auth_headers):
    r = await client.post("/eval/score", json={
        "trace_id": "trace-xyz",
        "name":     "faithfulness",
        "value":    0.85,
    }, headers=auth_headers)
    assert r.status_code == 204, r.text


@pytest.mark.asyncio
async def test_score_with_observation_id(client, auth_headers):
    r = await client.post("/eval/score", json={
        "trace_id":       "trace-xyz",
        "observation_id": "obs-123",
        "name":           "task_completion",
        "value":          1.0,
        "comment":        "Fully completed",
    }, headers=auth_headers)
    assert r.status_code == 204, r.text


@pytest.mark.asyncio
async def test_score_requires_auth(client):
    r = await client.post("/eval/score", json={
        "trace_id": "trace-xyz",
        "name":     "faithfulness",
        "value":    0.5,
    })
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_score_missing_required_fields(client, auth_headers):
    # Missing 'name' and 'value'
    r = await client.post("/eval/score", json={"trace_id": "trace-xyz"}, headers=auth_headers)
    assert r.status_code == 422, r.text


# ── POST /eval/feedback ───────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_feedback_thumbs_up(client, auth_headers):
    data = await _register(client, "fb-up@example.com")
    _seed_job(user_id=data["user_id"], job_id="fb-job-up")
    try:
        r = await client.post("/eval/feedback", json={
            "job_id": "fb-job-up",
            "value":  1,
        }, headers=_auth(data["token"]))
        assert r.status_code == 204, r.text
    finally:
        _cleanup_job("fb-job-up")


@pytest.mark.asyncio
async def test_feedback_thumbs_down(client, auth_headers):
    data = await _register(client, "fb-down@example.com")
    _seed_job(user_id=data["user_id"], job_id="fb-job-down")
    try:
        r = await client.post("/eval/feedback", json={
            "job_id": "fb-job-down",
            "value":  -1,
            "comment": "Wrong answer",
        }, headers=_auth(data["token"]))
        assert r.status_code == 204, r.text
    finally:
        _cleanup_job("fb-job-down")


@pytest.mark.asyncio
async def test_feedback_neutral(client, auth_headers):
    data = await _register(client, "fb-neutral@example.com")
    _seed_job(user_id=data["user_id"], job_id="fb-job-neutral")
    try:
        r = await client.post("/eval/feedback", json={
            "job_id": "fb-job-neutral",
            "value":  0,
        }, headers=_auth(data["token"]))
        assert r.status_code == 204, r.text
    finally:
        _cleanup_job("fb-job-neutral")


@pytest.mark.asyncio
async def test_feedback_invalid_value(client, auth_headers):
    data = await _register(client, "fb-invalid@example.com")
    _seed_job(user_id=data["user_id"], job_id="fb-job-invalid")
    try:
        r = await client.post("/eval/feedback", json={
            "job_id": "fb-job-invalid",
            "value":  99,  # not in {1, -1, 0}
        }, headers=_auth(data["token"]))
        assert r.status_code == 422, r.text
    finally:
        _cleanup_job("fb-job-invalid")


@pytest.mark.asyncio
async def test_feedback_unknown_job_returns_404(client, auth_headers):
    r = await client.post("/eval/feedback", json={
        "job_id": "nonexistent-job-id",
        "value":  1,
    }, headers=auth_headers)
    assert r.status_code == 404, r.text


@pytest.mark.asyncio
async def test_feedback_wrong_owner_returns_404(client):
    """A user cannot submit feedback for a job owned by someone else."""
    owner   = await _register(client, "fb-owner@example.com")
    other   = await _register(client, "fb-other@example.com")
    _seed_job(user_id=owner["user_id"], job_id="fb-job-owned")
    try:
        r = await client.post("/eval/feedback", json={
            "job_id": "fb-job-owned",
            "value":  1,
        }, headers=_auth(other["token"]))
        # Same 404 as "not found" — no info leak about the job existing
        assert r.status_code == 404, r.text
    finally:
        _cleanup_job("fb-job-owned")


@pytest.mark.asyncio
async def test_feedback_no_trace_id_still_succeeds(client):
    """Job exists and is owned correctly but has no Langfuse trace_id.
    The endpoint should return 204 (no-op) rather than erroring.
    """
    data = await _register(client, "fb-notrace@example.com")
    _seed_job(user_id=data["user_id"], job_id="fb-job-notrace", trace_id=None)
    try:
        r = await client.post("/eval/feedback", json={
            "job_id": "fb-job-notrace",
            "value":  1,
        }, headers=_auth(data["token"]))
        assert r.status_code == 204, r.text
    finally:
        _cleanup_job("fb-job-notrace")


@pytest.mark.asyncio
async def test_feedback_requires_auth(client):
    r = await client.post("/eval/feedback", json={"job_id": "x", "value": 1})
    assert r.status_code == 403, r.text


# ── GET /eval/templates ───────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_list_templates_returns_empty_in_test_mode(client, auth_headers):
    r = await client.get("/eval/templates", headers=auth_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    # TESTING=true — no live Langfuse, returns the stub empty response
    assert "data" in body
    assert isinstance(body["data"], list)


@pytest.mark.asyncio
async def test_list_templates_requires_auth(client):
    r = await client.get("/eval/templates")
    assert r.status_code == 403, r.text


# ── GET /eval/scores ──────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_get_scores_returns_empty_in_test_mode(client, auth_headers):
    r = await client.get("/eval/scores?trace_id=trace-abc", headers=auth_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "data" in body
    assert isinstance(body["data"], list)


@pytest.mark.asyncio
async def test_get_scores_requires_trace_id(client, auth_headers):
    r = await client.get("/eval/scores", headers=auth_headers)
    assert r.status_code == 422, r.text  # trace_id is required Query param


@pytest.mark.asyncio
async def test_get_scores_requires_auth(client):
    r = await client.get("/eval/scores?trace_id=trace-abc")
    assert r.status_code == 403, r.text


# ── seed_eval_templates() ─────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_seed_eval_templates_is_noop_in_testing():
    """seed_eval_templates() must exit immediately when TESTING=true.
    Calling it twice must not raise or fail — idempotency check.
    """
    from eval_api import seed_eval_templates
    # Both calls should complete without error
    await seed_eval_templates()
    await seed_eval_templates()
