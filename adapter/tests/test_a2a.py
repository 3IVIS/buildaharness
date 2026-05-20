"""
Tests for A2A protocol endpoints.

Covered:
  generate_agent_card()     — Python port matches expected AgentCard shape
  GET /.well-known/agent/{flow_id}.json — 404 with no deployment, 200 after deploy
  POST /deploy/a2a/{flow_id}            — 400 when a2a not enabled, 200 on success
  POST /deploy/a2a/{flow_id}            — idempotent: second deploy returns 200
  DELETE /deploy/a2a/{flow_id}          — removes deployment record, idempotent
  POST /a2a/{flow_id}/tasks/send        — 400 when a2a not enabled
  POST /a2a/{flow_id}/tasks/send        — 202 + task state "submitted" on valid flow
  POST /a2a/{flow_id}/tasks/send        — 409 on duplicate task ID
  GET  /a2a/{flow_id}/tasks/{task_id}   — 404 for unknown task
  GET  /a2a/{flow_id}/tasks/{task_id}   — 200 + correct state mapping
  Auth guards on all protected endpoints
  Graceful 404 when flow has no a2a_config.enabled
"""

import pytest

# ── Test specs ────────────────────────────────────────────────────────────────

MINIMAL_SPEC_NO_A2A = {
    "spec_version": "0.2.0",
    "id":           "no-a2a-flow",
    "name":         "No A2A Flow",
    "nodes": [
        {"id": "input-1",  "type": "input",  "position": {"x": 0,   "y": 0}},
        {"id": "output-1", "type": "output", "position": {"x": 300, "y": 0}},
    ],
    "edges": [{"id": "e1", "type": "direct", "from": "input-1", "to": "output-1"}],
}

A2A_FLOW_SPEC = {
    "spec_version": "0.2.0",
    "id":           "a2a-test-flow",
    "name":         "A2A Test Agent",
    "description":  "A test agent for the A2A test suite",
    "nodes": [
        {"id": "input-1",  "type": "input",  "position": {"x": 0,   "y": 0}},
        {"id": "output-1", "type": "output", "position": {"x": 300, "y": 0}},
    ],
    "edges": [{"id": "e1", "type": "direct", "from": "input-1", "to": "output-1"}],
    "flow_config": {
        "a2a_config": {
            "enabled":           True,
            "agent_name":        "Test Agent",
            "agent_description": "Runs tests",
            "version":           "1.0.0",
            "authentication":    "api_key",
            "capabilities":      ["streaming"],
            "skills": [
                {"id": "test-skill", "name": "Test Skill", "description": "A test skill"},
            ],
        }
    },
}

# ── helpers ───────────────────────────────────────────────────────────────────

async def _register(client, email: str, password: str = "Password1") -> dict:
    r = await client.post("/auth/register", json={"email": email, "password": password})
    assert r.status_code == 201, r.text
    return r.json()


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


async def _save_flow(client, headers: dict, spec: dict) -> None:
    r = await client.post("/flows", json={"spec": spec}, headers=headers)
    assert r.status_code == 200, r.text


# ── generate_agent_card() unit tests ─────────────────────────────────────────

def test_generate_agent_card_none_when_disabled():
    from a2a_api import generate_agent_card
    spec = {"flow_config": {"a2a_config": {"enabled": False}}}
    assert generate_agent_card("flow-1", "My Flow", None, spec.get("flow_config")) is None


def test_generate_agent_card_none_when_no_a2a_config():
    from a2a_api import generate_agent_card
    assert generate_agent_card("flow-1", "My Flow", None, None) is None


def test_generate_agent_card_shape():
    from a2a_api import generate_agent_card
    card = generate_agent_card(
        flow_id="a2a-test-flow",
        flow_name="A2A Test Agent",
        flow_description="A test agent",
        flow_config=A2A_FLOW_SPEC["flow_config"],
        base_url="http://localhost:8000",
    )
    assert card is not None
    assert card["name"] == "Test Agent"
    assert card["description"] == "Runs tests"
    assert card["url"] == "http://localhost:8000/.well-known/agent/a2a-test-flow.json"
    assert card["version"] == "1.0.0"
    assert card["capabilities"]["streaming"] is True
    assert card["capabilities"]["pushNotifications"] is False
    assert card["authentication"] == {"schemes": ["api_key"]}
    assert len(card["skills"]) == 1
    assert card["skills"][0]["id"] == "test-skill"


def test_generate_agent_card_uses_flow_name_as_fallback():
    from a2a_api import generate_agent_card
    card = generate_agent_card(
        flow_id="flow-1",
        flow_name="Fallback Name",
        flow_description=None,
        flow_config={"a2a_config": {"enabled": True}},
    )
    assert card is not None
    assert card["name"] == "Fallback Name"
    assert card["skills"] == []


# ── Well-known discovery (public) ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_well_known_404_when_no_deployments(client):
    r = await client.get("/.well-known/agent.json")
    assert r.status_code == 404, r.text


@pytest.mark.asyncio
async def test_well_known_flow_404_before_deploy(client):
    r = await client.get("/.well-known/agent/a2a-test-flow.json")
    assert r.status_code == 404, r.text


# ── POST /deploy/a2a/{flow_id} ────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_deploy_requires_auth(client):
    r = await client.post("/deploy/a2a/any-flow")
    assert r.status_code == 401, r.text


@pytest.mark.asyncio
async def test_deploy_404_when_flow_missing(client, auth_headers):
    r = await client.post("/deploy/a2a/nonexistent-flow", headers=auth_headers)
    assert r.status_code == 404, r.text


@pytest.mark.asyncio
async def test_deploy_400_when_a2a_not_enabled(client, auth_headers):
    await _save_flow(client, auth_headers, MINIMAL_SPEC_NO_A2A)
    r = await client.post("/deploy/a2a/no-a2a-flow", headers=auth_headers)
    assert r.status_code == 400, r.text
    assert "not have A2A enabled" in r.json()["detail"]


@pytest.mark.asyncio
async def test_deploy_success_returns_endpoint_url(client, auth_headers):
    await _save_flow(client, auth_headers, A2A_FLOW_SPEC)
    r = await client.post("/deploy/a2a/a2a-test-flow", headers=auth_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["flow_id"] == "a2a-test-flow"
    assert "/a2a/a2a-test-flow/tasks/send" in body["endpoint_url"]
    assert body["agent_card"]["name"] == "Test Agent"
    assert "deployed_at" in body


@pytest.mark.asyncio
async def test_deploy_idempotent_second_call_returns_200(client, auth_headers):
    await _save_flow(client, auth_headers, A2A_FLOW_SPEC)
    r1 = await client.post("/deploy/a2a/a2a-test-flow", headers=auth_headers)
    r2 = await client.post("/deploy/a2a/a2a-test-flow", headers=auth_headers)
    assert r1.status_code == 200, r1.text
    assert r2.status_code == 200, r2.text


@pytest.mark.asyncio
async def test_well_known_returns_agent_card_after_deploy(client, auth_headers):
    await _save_flow(client, auth_headers, A2A_FLOW_SPEC)
    await client.post("/deploy/a2a/a2a-test-flow", headers=auth_headers)
    # Public endpoint — no auth
    r = await client.get("/.well-known/agent/a2a-test-flow.json")
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "Test Agent"


# ── DELETE /deploy/a2a/{flow_id} ──────────────────────────────────────────────

@pytest.mark.asyncio
async def test_undeploy_requires_auth(client):
    r = await client.delete("/deploy/a2a/any-flow")
    assert r.status_code == 401, r.text


@pytest.mark.asyncio
async def test_undeploy_idempotent_when_not_deployed(client, auth_headers):
    """Undeploying a flow that was never deployed returns 204 (no-op)."""
    await _save_flow(client, auth_headers, A2A_FLOW_SPEC)
    r = await client.delete("/deploy/a2a/a2a-test-flow", headers=auth_headers)
    assert r.status_code == 204, r.text


@pytest.mark.asyncio
async def test_undeploy_removes_deployment(client, auth_headers):
    await _save_flow(client, auth_headers, A2A_FLOW_SPEC)
    await client.post("/deploy/a2a/a2a-test-flow", headers=auth_headers)
    r = await client.delete("/deploy/a2a/a2a-test-flow", headers=auth_headers)
    assert r.status_code == 204, r.text
    # Discovery endpoint should now 404
    r2 = await client.get("/.well-known/agent/a2a-test-flow.json")
    assert r2.status_code == 404, r2.text


@pytest.mark.asyncio
async def test_deploy_403_when_existing_deployment_owned_by_different_user(client, db_engine):
    """Deploy guard: if an A2ADeployment row already exists for a flow and belongs to a
    different user, POST /deploy/a2a/{flow_id} returns 403.

    Flow.id is a global primary key so two users can never normally own flows with the
    same ID via the HTTP API.  We test the guard by:
      1. Saving and deploying as user A (normal path).
      2. Directly updating the deployment's user_id in the DB to user B's ID (simulates
         an out-of-band ownership transfer that would only happen via DB admin action).
      3. Verifying that user A's re-deploy now returns 403.
    """
    from sqlalchemy import update
    from sqlalchemy.ext.asyncio import async_sessionmaker
    from db import A2ADeployment

    user_a = await _register(client, "deploy-guard-a@example.com")
    user_b = await _register(client, "deploy-guard-b@example.com")

    # User A saves and deploys successfully
    await _save_flow(client, _auth(user_a["token"]), A2A_FLOW_SPEC)
    r1 = await client.post("/deploy/a2a/a2a-test-flow", headers=_auth(user_a["token"]))
    assert r1.status_code == 200, r1.text

    # Directly reassign the deployment's user_id to user_b in the DB
    import uuid
    SessionLocal = async_sessionmaker(db_engine, expire_on_commit=False)
    async with SessionLocal() as session:
        await session.execute(
            update(A2ADeployment)
            .where(A2ADeployment.flow_id == "a2a-test-flow")
            .values(user_id=uuid.UUID(user_b["user_id"]))
        )
        await session.commit()

    # User A tries to re-deploy — deployment now belongs to user_b → 403
    r2 = await client.post("/deploy/a2a/a2a-test-flow", headers=_auth(user_a["token"]))
    assert r2.status_code == 403, r2.text


@pytest.mark.asyncio
async def test_undeploy_403_wrong_owner(client):
    """Attempting to undeploy a flow owned by a different user returns 404 (not found).

    The ownership check on the *flow* (via _get_flow_owned) fires before the
    deployment record check.  User B cannot see user A's flow at all — same silent-404
    as the rest of the ownership model.
    """
    user_a = await _register(client, "undeploy-owner-a@example.com")
    user_b = await _register(client, "undeploy-owner-b@example.com")

    # User A deploys
    await _save_flow(client, _auth(user_a["token"]), A2A_FLOW_SPEC)
    await client.post("/deploy/a2a/a2a-test-flow", headers=_auth(user_a["token"]))

    # User B tries to undeploy — gets 404 because _get_flow_owned filters by user
    r = await client.delete("/deploy/a2a/a2a-test-flow", headers=_auth(user_b["token"]))
    assert r.status_code == 404, r.text


# ── POST /a2a/{flow_id}/tasks/send ────────────────────────────────────────────

@pytest.mark.asyncio
async def test_task_send_requires_auth(client):
    r = await client.post("/a2a/any-flow/tasks/send", json={
        "id": "task-1", "message": {"role": "user", "parts": [{"text": "hi"}]},
    })
    assert r.status_code == 401, r.text


@pytest.mark.asyncio
async def test_task_send_404_flow_not_found(client, auth_headers):
    r = await client.post("/a2a/ghost-flow/tasks/send", json={
        "id": "task-1", "message": {"role": "user", "parts": [{"text": "hi"}]},
    }, headers=auth_headers)
    assert r.status_code == 404, r.text


@pytest.mark.asyncio
async def test_task_send_400_a2a_not_enabled(client, auth_headers):
    await _save_flow(client, auth_headers, MINIMAL_SPEC_NO_A2A)
    r = await client.post("/a2a/no-a2a-flow/tasks/send", json={
        "id": "task-1", "message": {"role": "user", "parts": [{"text": "hi"}]},
    }, headers=auth_headers)
    assert r.status_code == 400, r.text
    assert "not have A2A enabled" in r.json()["detail"]


@pytest.mark.asyncio
async def test_task_send_returns_submitted_state(client, auth_headers):
    await _save_flow(client, auth_headers, A2A_FLOW_SPEC)
    r = await client.post("/a2a/a2a-test-flow/tasks/send", json={
        "id": "task-abc-123",
        "message": {"role": "user", "parts": [{"type": "text", "text": "run please"}]},
    }, headers=auth_headers)
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["id"] == "task-abc-123"
    assert body["flow_id"] == "a2a-test-flow"
    assert body["status"]["state"] == "submitted"


@pytest.mark.asyncio
async def test_task_send_409_duplicate_task_id(client, auth_headers, db_engine):
    """Sending a task with an already-used ID returns 409 Conflict."""
    from sqlalchemy.ext.asyncio import async_sessionmaker as _asm
    from run_api import _jobs_create

    # Get the user_id of the authenticated user so the FK is satisfied.
    me = await client.get("/auth/me", headers=auth_headers)
    user_id = me.json()["user_id"]

    SessionLocal = _asm(db_engine, expire_on_commit=False)
    async with SessionLocal() as db:
        await _jobs_create("dup-task-xyz", user_id, "langgraph", db)

    await _save_flow(client, auth_headers, A2A_FLOW_SPEC)
    r = await client.post("/a2a/a2a-test-flow/tasks/send", json={
        "id": "dup-task-xyz",
        "message": {"role": "user", "parts": [{"text": "hi"}]},
    }, headers=auth_headers)
    assert r.status_code == 409, r.text


# ── GET /a2a/{flow_id}/tasks/{task_id} ────────────────────────────────────────

@pytest.mark.asyncio
async def test_get_task_requires_auth(client):
    r = await client.get("/a2a/any-flow/tasks/any-task")
    assert r.status_code == 401, r.text


@pytest.mark.asyncio
async def test_get_task_404_unknown(client, auth_headers):
    await _save_flow(client, auth_headers, A2A_FLOW_SPEC)
    r = await client.get("/a2a/a2a-test-flow/tasks/nonexistent", headers=auth_headers)
    assert r.status_code == 404, r.text


@pytest.mark.asyncio
async def test_task_send_422_empty_task_id(client, auth_headers):
    """Empty string task ID should be rejected with 422 (Pydantic min_length=1)."""
    await _save_flow(client, auth_headers, A2A_FLOW_SPEC)
    r = await client.post("/a2a/a2a-test-flow/tasks/send", json={
        "id": "",
        "message": {"role": "user", "parts": [{"text": "hi"}]},
    }, headers=auth_headers)
    assert r.status_code == 422, r.text


@pytest.mark.asyncio
async def test_get_task_state_after_send(client, auth_headers):
    await _save_flow(client, auth_headers, A2A_FLOW_SPEC)
    send = await client.post("/a2a/a2a-test-flow/tasks/send", json={
        "id": "get-task-test",
        "message": {"role": "user", "parts": [{"text": "query"}]},
    }, headers=auth_headers)
    assert send.status_code == 202
    task_id = send.json()["id"]

    r = await client.get(f"/a2a/a2a-test-flow/tasks/{task_id}", headers=auth_headers)
    assert r.status_code == 200, r.text
    state = r.json()["status"]["state"]
    assert state in ("submitted", "working", "completed", "failed")


# ── GET /a2a/{flow_id}/tasks/{task_id}/events (SSE) ───────────────────────────

@pytest.mark.asyncio
async def test_task_events_requires_auth(client):
    """SSE endpoint returns 401 without credentials."""
    r = await client.get("/a2a/any-flow/tasks/any-task/events")
    assert r.status_code == 401, r.text


@pytest.mark.asyncio
async def test_task_events_404_unknown_task(client, auth_headers):
    """SSE endpoint returns 404 when task_id is not in _jobs."""
    await _save_flow(client, auth_headers, A2A_FLOW_SPEC)
    r = await client.get(
        "/a2a/a2a-test-flow/tasks/nonexistent-task-id/events",
        headers=auth_headers,
    )
    assert r.status_code == 404, r.text
