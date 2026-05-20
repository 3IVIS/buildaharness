"""
Tests for unified one-click deployment (REST + MCP + A2A).

Covered:
  generate_mcp_manifest()       — correct shape, field type mapping, tool name sanitisation
  POST /deploy/{flow_id}        — 404 on unknown flow, 200 on success (REST+MCP)
  POST /deploy/{flow_id}        — also upserts a2a_deployments when A2A is enabled
  POST /deploy/{flow_id}        — idempotent: re-deploy returns 200 with updated manifest
  POST /deploy/{flow_id}        — 403 when flow belongs to a different user
  DELETE /deploy/{flow_id}      — removes unified row, idempotent
  DELETE /deploy/{flow_id}      — also removes a2a_deployments row when present
  GET /.well-known/mcp/{id}.json — 404 before deploy, 200 after deploy
  GET /share/{flow_id}          — 404 before deploy, 200 with flow metadata after
  POST /flows/{flow_id}/invoke  — 404 when no deployment, 200 on deployed non-HITL flow
  POST /flows/{flow_id}/invoke  — 504 on synthetic timeout (mocked)
  Auth guards on all protected endpoints
"""

import asyncio
import pytest
from unittest.mock import AsyncMock, patch

# ── Shared test specs ─────────────────────────────────────────────────────────

MINIMAL_SPEC = {
    "spec_version": "0.2.0",
    "id":           "deploy-test-flow",
    "name":         "Deploy Test Flow",
    "nodes": [
        {"id": "input-1",  "type": "input",  "position": {"x": 0,   "y": 0}},
        {"id": "output-1", "type": "output", "position": {"x": 300, "y": 0}},
    ],
    "edges": [{"id": "e1", "type": "direct", "from": "input-1", "to": "output-1"}],
    "state_schema": {
        "fields": [
            {"name": "query",   "type": "str",       "reducer": "replace"},
            {"name": "results", "type": "list[str]", "reducer": "append"},
        ]
    },
}

A2A_SPEC = {
    **MINIMAL_SPEC,
    "id":   "a2a-deploy-flow",
    "name": "A2A Deploy Flow",
    "flow_config": {
        "a2a_config": {
            "enabled":      True,
            "agent_name":   "Deploy Test Agent",
            "version":      "1.0.0",
            "capabilities": ["streaming"],
        }
    },
}


# ── Helpers ───────────────────────────────────────────────────────────────────

async def _register(client, email: str, password: str = "Password1") -> dict:
    r = await client.post("/auth/register", json={"email": email, "password": password})
    assert r.status_code == 201, r.text
    return r.json()


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


async def _save_flow(client, headers: dict, spec: dict) -> None:
    r = await client.post("/flows", json={"spec": spec}, headers=headers)
    assert r.status_code == 200, r.text


# ── generate_mcp_manifest() unit tests ───────────────────────────────────────

def test_generate_mcp_manifest_basic():
    from deploy_api import generate_mcp_manifest
    manifest = generate_mcp_manifest(
        flow_id="flow-1",
        flow_name="My Test Flow",
        flow_description="Does something",
        spec=MINIMAL_SPEC,
        base_url="http://localhost:8000",
    )
    assert manifest["schema_version"] == "v1"
    assert len(manifest["tools"]) == 1
    tool = manifest["tools"][0]
    assert tool["name"] == "my_test_flow"
    assert tool["description"] == "Does something"
    assert tool["endpoint"] == "http://localhost:8000/flows/flow-1/invoke"


def test_generate_mcp_manifest_input_schema():
    from deploy_api import generate_mcp_manifest
    manifest = generate_mcp_manifest(
        flow_id="f",
        flow_name="F",
        flow_description=None,
        spec=MINIMAL_SPEC,
    )
    schema = manifest["tools"][0]["inputSchema"]
    assert schema["type"] == "object"
    # "query" (replace reducer) should be in properties
    assert "query" in schema["properties"]
    assert schema["properties"]["query"]["type"] == "string"
    # "results" (append reducer) → array, not in required
    assert "results" in schema["properties"]
    assert schema["properties"]["results"]["type"] == "array"
    assert "results" not in schema.get("required", [])
    # "query" should be required
    assert "query" in schema.get("required", [])


def test_generate_mcp_manifest_tool_name_sanitisation():
    from deploy_api import generate_mcp_manifest
    manifest = generate_mcp_manifest(
        flow_id="f", flow_name="Hello, World! (v2)", flow_description=None, spec={}
    )
    assert manifest["tools"][0]["name"] == "hello_world_v2"


def test_generate_mcp_manifest_no_state_schema():
    from deploy_api import generate_mcp_manifest
    manifest = generate_mcp_manifest(
        flow_id="f", flow_name="Simple", flow_description=None, spec={}
    )
    tool = manifest["tools"][0]
    assert tool["inputSchema"]["properties"] == {}
    assert "required" not in tool["inputSchema"]


def test_generate_mcp_manifest_type_mapping():
    from deploy_api import generate_mcp_manifest
    spec = {
        "state_schema": {
            "fields": [
                {"name": "count",  "type": "int",   "reducer": "replace"},
                {"name": "ratio",  "type": "float", "reducer": "replace"},
                {"name": "active", "type": "bool",  "reducer": "replace"},
                {"name": "meta",   "type": "dict",  "reducer": "replace"},
            ]
        }
    }
    manifest = generate_mcp_manifest("f", "F", None, spec)
    props = manifest["tools"][0]["inputSchema"]["properties"]
    assert props["count"]["type"]  == "integer"
    assert props["ratio"]["type"]  == "number"
    assert props["active"]["type"] == "boolean"
    assert props["meta"]["type"]   == "object"


# ── POST /deploy/{flow_id} ────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_unified_deploy_404_unknown_flow(client):
    creds = await _register(client, "deploy1@test.com")
    r = await client.post("/deploy/nonexistent", headers=_auth(creds["token"]))
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_unified_deploy_success(client):
    creds = await _register(client, "deploy2@test.com")
    h = _auth(creds["token"])
    await _save_flow(client, h, MINIMAL_SPEC)

    r = await client.post(f"/deploy/{MINIMAL_SPEC['id']}", headers=h)
    assert r.status_code == 200, r.text

    body = r.json()
    assert body["flow_id"]       == MINIMAL_SPEC["id"]
    assert "/flows/"             in body["rest_url"]
    assert "invoke"              in body["rest_url"]
    assert "/.well-known/mcp/"  in body["mcp_url"]
    assert body["a2a_url"]      is None   # no a2a_config
    assert "/share/"            in body["shareable_url"]
    assert "tools"              in body["mcp_manifest"]
    assert body["mcp_manifest"]["tools"][0]["name"] == "deploy_test_flow"


@pytest.mark.asyncio
async def test_unified_deploy_also_upserts_a2a(client):
    creds = await _register(client, "deploy3@test.com")
    h = _auth(creds["token"])
    await _save_flow(client, h, A2A_SPEC)

    r = await client.post(f"/deploy/{A2A_SPEC['id']}", headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    # A2A URL should be set
    assert body["a2a_url"] is not None
    assert "/a2a/" in body["a2a_url"]

    # A2A discovery endpoint should now return an AgentCard
    r2 = await client.get(f"/.well-known/agent/{A2A_SPEC['id']}.json")
    assert r2.status_code == 200
    card = r2.json()
    assert card["name"] == "Deploy Test Agent"


@pytest.mark.asyncio
async def test_unified_deploy_idempotent(client):
    creds = await _register(client, "deploy4@test.com")
    h = _auth(creds["token"])
    await _save_flow(client, h, MINIMAL_SPEC)

    r1 = await client.post(f"/deploy/{MINIMAL_SPEC['id']}", headers=h)
    r2 = await client.post(f"/deploy/{MINIMAL_SPEC['id']}", headers=h)
    assert r1.status_code == 200
    assert r2.status_code == 200
    # Both return the same flow_id
    assert r1.json()["flow_id"] == r2.json()["flow_id"]


@pytest.mark.asyncio
async def test_unified_deploy_auth_required(client):
    r = await client.post(f"/deploy/{MINIMAL_SPEC['id']}")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_unified_deploy_wrong_user(client):
    creds1 = await _register(client, "deploy5a@test.com")
    creds2 = await _register(client, "deploy5b@test.com")

    # User 1 saves + deploys
    h1 = _auth(creds1["token"])
    await _save_flow(client, h1, MINIMAL_SPEC)
    r = await client.post(f"/deploy/{MINIMAL_SPEC['id']}", headers=h1)
    assert r.status_code == 200

    # User 2 tries to deploy the same flow_id — 404 (doesn't own the flow)
    h2 = _auth(creds2["token"])
    r2 = await client.post(f"/deploy/{MINIMAL_SPEC['id']}", headers=h2)
    assert r2.status_code == 404


# ── DELETE /deploy/{flow_id} ──────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_unified_undeploy_removes_row(client):
    creds = await _register(client, "undeploy1@test.com")
    h = _auth(creds["token"])
    await _save_flow(client, h, MINIMAL_SPEC)

    await client.post(f"/deploy/{MINIMAL_SPEC['id']}", headers=h)
    r = await client.delete(f"/deploy/{MINIMAL_SPEC['id']}", headers=h)
    assert r.status_code == 204

    # MCP manifest should now 404
    r2 = await client.get(f"/.well-known/mcp/{MINIMAL_SPEC['id']}.json")
    assert r2.status_code == 404


@pytest.mark.asyncio
async def test_unified_undeploy_also_removes_a2a(client):
    creds = await _register(client, "undeploy2@test.com")
    h = _auth(creds["token"])
    await _save_flow(client, h, A2A_SPEC)
    await client.post(f"/deploy/{A2A_SPEC['id']}", headers=h)

    # Both discovery endpoints should work
    r = await client.get(f"/.well-known/agent/{A2A_SPEC['id']}.json")
    assert r.status_code == 200

    await client.delete(f"/deploy/{A2A_SPEC['id']}", headers=h)

    # A2A discovery should now 404
    r2 = await client.get(f"/.well-known/agent/{A2A_SPEC['id']}.json")
    assert r2.status_code == 404


@pytest.mark.asyncio
async def test_unified_undeploy_idempotent(client):
    creds = await _register(client, "undeploy3@test.com")
    h = _auth(creds["token"])
    await _save_flow(client, h, MINIMAL_SPEC)
    await client.post(f"/deploy/{MINIMAL_SPEC['id']}", headers=h)
    r1 = await client.delete(f"/deploy/{MINIMAL_SPEC['id']}", headers=h)
    r2 = await client.delete(f"/deploy/{MINIMAL_SPEC['id']}", headers=h)
    assert r1.status_code == 204
    assert r2.status_code == 204


# ── GET /.well-known/mcp/{flow_id}.json ──────────────────────────────────────

@pytest.mark.asyncio
async def test_mcp_manifest_404_before_deploy(client):
    r = await client.get("/.well-known/mcp/never-deployed.json")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_mcp_manifest_200_after_deploy(client):
    creds = await _register(client, "mcp1@test.com")
    h = _auth(creds["token"])
    await _save_flow(client, h, MINIMAL_SPEC)
    await client.post(f"/deploy/{MINIMAL_SPEC['id']}", headers=h)

    r = await client.get(f"/.well-known/mcp/{MINIMAL_SPEC['id']}.json")
    assert r.status_code == 200
    body = r.json()
    assert "tools" in body
    assert body["tools"][0]["name"] == "deploy_test_flow"


@pytest.mark.asyncio
async def test_mcp_manifest_public_no_auth(client):
    """MCP discovery endpoint must be accessible without a JWT."""
    creds = await _register(client, "mcp2@test.com")
    h = _auth(creds["token"])
    await _save_flow(client, h, MINIMAL_SPEC)
    await client.post(f"/deploy/{MINIMAL_SPEC['id']}", headers=h)

    # Request without Authorization header
    r = await client.get(f"/.well-known/mcp/{MINIMAL_SPEC['id']}.json")
    assert r.status_code == 200


# ── GET /share/{flow_id} ──────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_share_404_before_deploy(client):
    r = await client.get("/share/no-such-flow")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_share_200_after_deploy(client):
    creds = await _register(client, "share1@test.com")
    h = _auth(creds["token"])
    await _save_flow(client, h, MINIMAL_SPEC)
    await client.post(f"/deploy/{MINIMAL_SPEC['id']}", headers=h)

    r = await client.get(f"/share/{MINIMAL_SPEC['id']}")
    assert r.status_code == 200
    body = r.json()
    assert body["flow_id"]   == MINIMAL_SPEC["id"]
    assert body["flow_name"] == MINIMAL_SPEC["name"]
    assert "rest_url"        in body
    assert "mcp_url"         in body
    assert "shareable_url"   in body


@pytest.mark.asyncio
async def test_share_public_no_auth(client):
    creds = await _register(client, "share2@test.com")
    h = _auth(creds["token"])
    await _save_flow(client, h, MINIMAL_SPEC)
    await client.post(f"/deploy/{MINIMAL_SPEC['id']}", headers=h)
    r = await client.get(f"/share/{MINIMAL_SPEC['id']}")
    assert r.status_code == 200


# ── POST /flows/{flow_id}/invoke ──────────────────────────────────────────────

@pytest.mark.asyncio
async def test_invoke_404_when_not_deployed(client):
    creds = await _register(client, "invoke1@test.com")
    h = _auth(creds["token"])
    await _save_flow(client, h, MINIMAL_SPEC)

    r = await client.post(
        f"/flows/{MINIMAL_SPEC['id']}/invoke",
        json={"input": {"query": "hello"}},
        headers=h,
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_invoke_success_with_mock_runner(client):
    """Invoke returns 200 with job_id when the runner completes successfully."""
    creds = await _register(client, "invoke2@test.com")
    h = _auth(creds["token"])
    await _save_flow(client, h, MINIMAL_SPEC)
    await client.post(f"/deploy/{MINIMAL_SPEC['id']}", headers=h)

    async def _fake_run(job_id, spec, org_id=None):
        import run_api as _ra
        from db import Job
        async with _ra._job_session() as db:
            job = await _ra._jobs_get(job_id, db)
            if job:
                job.status = "done"
                job.result = '{"output": "ok"}'
                await db.commit()

    with patch("deploy_api._run_langgraph", side_effect=_fake_run):
        r = await client.post(
            f"/flows/{MINIMAL_SPEC['id']}/invoke",
            json={"input": {"query": "hello"}},
            headers=h,
        )

    assert r.status_code == 200, r.text
    body = r.json()
    assert "job_id"  in body
    assert "output"  in body
    assert body["runtime"] == "langgraph"


@pytest.mark.asyncio
async def test_invoke_504_on_timeout(client):
    creds = await _register(client, "invoke3@test.com")
    h = _auth(creds["token"])
    await _save_flow(client, h, MINIMAL_SPEC)
    await client.post(f"/deploy/{MINIMAL_SPEC['id']}", headers=h)

    async def _hang(job_id, spec, org_id=None):
        await asyncio.sleep(999)

    with patch("deploy_api._run_langgraph", side_effect=_hang), \
         patch("deploy_api.INVOKE_TIMEOUT_S", 0):
        r = await client.post(
            f"/flows/{MINIMAL_SPEC['id']}/invoke",
            json={"input": {}},
            headers=h,
        )
    assert r.status_code == 504


@pytest.mark.asyncio
async def test_invoke_auth_required(client):
    r = await client.post(f"/flows/{MINIMAL_SPEC['id']}/invoke", json={"input": {}})
    assert r.status_code == 401
