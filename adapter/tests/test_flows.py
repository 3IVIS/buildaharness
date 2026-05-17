"""
Tests for /flows CRUD + versioning.
"""
import copy
import pytest
from tests.conftest import MINIMAL_SPEC


@pytest.mark.asyncio
async def test_save_and_get_flow(client, auth_headers):
    r = await client.post("/flows", json={"spec": MINIMAL_SPEC}, headers=auth_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["id"] == "test-flow"
    assert body["version_num"] == 1

    r2 = await client.get("/flows/test-flow", headers=auth_headers)
    assert r2.status_code == 200
    assert r2.json()["id"] == "test-flow"


@pytest.mark.asyncio
async def test_save_increments_version(client, auth_headers):
    await client.post("/flows", json={"spec": MINIMAL_SPEC}, headers=auth_headers)
    r2 = await client.post("/flows", json={"spec": MINIMAL_SPEC}, headers=auth_headers)
    assert r2.json()["version_num"] == 2


@pytest.mark.asyncio
async def test_list_flows(client, auth_headers):
    await client.post("/flows", json={"spec": MINIMAL_SPEC}, headers=auth_headers)
    r = await client.get("/flows", headers=auth_headers)
    assert r.status_code == 200
    ids = [f["id"] for f in r.json()]
    assert "test-flow" in ids


@pytest.mark.asyncio
async def test_list_flows_isolated_between_users(client, auth_headers):
    """A second user must not see the first user's flows."""
    await client.post("/flows", json={"spec": MINIMAL_SPEC}, headers=auth_headers)

    r2 = await client.post("/auth/register", json={
        "email": "other@example.com", "password": "Password1",
    })
    other_headers = {"Authorization": f"Bearer {r2.json()['token']}"}

    r = await client.get("/flows", headers=other_headers)
    assert r.status_code == 200
    assert r.json() == []


@pytest.mark.asyncio
async def test_get_flow_not_found(client, auth_headers):
    r = await client.get("/flows/does-not-exist", headers=auth_headers)
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_delete_flow(client, auth_headers):
    await client.post("/flows", json={"spec": MINIMAL_SPEC}, headers=auth_headers)
    r = await client.delete("/flows/test-flow", headers=auth_headers)
    assert r.status_code == 204
    r2 = await client.get("/flows/test-flow", headers=auth_headers)
    assert r2.status_code == 404


@pytest.mark.asyncio
async def test_save_flow_rejects_missing_id(client, auth_headers):
    bad_spec = copy.deepcopy(MINIMAL_SPEC)
    del bad_spec["id"]
    r = await client.post("/flows", json={"spec": bad_spec}, headers=auth_headers)
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_save_flow_rejects_invalid_spec(client, auth_headers):
    """Fix #7: save_flow now validates the spec structure before storing."""
    r = await client.post("/flows", json={"spec": {
        "id": "bad-flow",
        "spec_version": "0.2.0",
        "nodes": [],    # empty nodes — should fail validation
        "edges": [],
    }}, headers=auth_headers)
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_version_history_and_restore(client, auth_headers):
    await client.post("/flows", json={"spec": MINIMAL_SPEC}, headers=auth_headers)

    spec_v2 = copy.deepcopy(MINIMAL_SPEC)
    spec_v2["name"] = "Updated"
    await client.post("/flows", json={"spec": spec_v2}, headers=auth_headers)

    # List versions — newest first
    r = await client.get("/flows/test-flow/versions", headers=auth_headers)
    assert r.status_code == 200
    versions = r.json()
    assert len(versions) == 2
    assert versions[0]["version_num"] == 2

    # Restore v1
    ver_id = versions[1]["id"]  # version_num == 1
    r2 = await client.post(
        f"/flows/test-flow/versions/{ver_id}/restore", headers=auth_headers
    )
    assert r2.status_code == 200
    assert r2.json()["version_num"] == 3  # restore creates a new version
