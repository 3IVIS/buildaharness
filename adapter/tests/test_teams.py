"""
Tests for POST /teams and sub-resources.

All assertions use the in-memory SQLite test database (no Postgres needed).
"""

import pytest

# ── helpers ───────────────────────────────────────────────────────────────────

async def _register(client, email, password="Password1"):  # noqa: S107
    r = await client.post("/auth/register", json={"email": email, "password": password})
    assert r.status_code == 201, r.text
    return r.json()["token"]


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


# ── team CRUD ─────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_create_team(client, auth_headers):
    r = await client.post("/teams", json={"name": "Acme"}, headers=auth_headers)
    assert r.status_code == 201
    body = r.json()
    assert body["name"] == "Acme"
    assert len(body["members"]) == 1
    assert body["members"][0]["role"] == "admin"


@pytest.mark.asyncio
async def test_list_teams_empty(client, auth_headers):
    r = await client.get("/teams", headers=auth_headers)
    assert r.status_code == 200
    assert r.json() == []


@pytest.mark.asyncio
async def test_list_teams_after_create(client, auth_headers):
    await client.post("/teams", json={"name": "Beta"}, headers=auth_headers)
    r = await client.get("/teams", headers=auth_headers)
    assert r.status_code == 200
    assert any(t["name"] == "Beta" for t in r.json())


@pytest.mark.asyncio
async def test_get_team(client, auth_headers):
    cr = await client.post("/teams", json={"name": "Gamma"}, headers=auth_headers)
    team_id = cr.json()["id"]
    r = await client.get(f"/teams/{team_id}", headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["name"] == "Gamma"


@pytest.mark.asyncio
async def test_get_team_non_member_forbidden(client, auth_headers):
    cr = await client.post("/teams", json={"name": "Secret"}, headers=auth_headers)
    team_id = cr.json()["id"]
    other_token = await _register(client, "other@example.com")
    r = await client.get(f"/teams/{team_id}", headers=_auth(other_token))
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_rename_team(client, auth_headers):
    cr = await client.post("/teams", json={"name": "Old"}, headers=auth_headers)
    team_id = cr.json()["id"]
    r = await client.patch(f"/teams/{team_id}", json={"name": "New"}, headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["name"] == "New"


@pytest.mark.asyncio
async def test_rename_team_non_admin_forbidden(client, auth_headers):
    cr = await client.post("/teams", json={"name": "Alpha"}, headers=auth_headers)
    team_id = cr.json()["id"]
    editor_token = await _register(client, "editor@example.com")
    # Invite as editor
    await client.post(
        f"/teams/{team_id}/members",
        json={"email": "editor@example.com", "role": "editor"},
        headers=auth_headers,
    )
    r = await client.patch(
        f"/teams/{team_id}", json={"name": "Hacked"}, headers=_auth(editor_token),
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_delete_team(client, auth_headers):
    cr = await client.post("/teams", json={"name": "Temp"}, headers=auth_headers)
    team_id = cr.json()["id"]
    r = await client.delete(f"/teams/{team_id}", headers=auth_headers)
    assert r.status_code == 204
    r2 = await client.get(f"/teams/{team_id}", headers=auth_headers)
    assert r2.status_code in (403, 404)


# ── member management ─────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_invite_member(client, auth_headers):
    cr = await client.post("/teams", json={"name": "Invites"}, headers=auth_headers)
    team_id = cr.json()["id"]
    await _register(client, "newmember@example.com")

    r = await client.post(
        f"/teams/{team_id}/members",
        json={"email": "newmember@example.com", "role": "editor"},
        headers=auth_headers,
    )
    assert r.status_code == 201
    body = r.json()
    assert body["role"] == "editor"
    assert body["email"] == "newmember@example.com"


@pytest.mark.asyncio
async def test_invite_nonexistent_user_404(client, auth_headers):
    cr = await client.post("/teams", json={"name": "NoOne"}, headers=auth_headers)
    team_id = cr.json()["id"]
    r = await client.post(
        f"/teams/{team_id}/members",
        json={"email": "ghost@example.com", "role": "viewer"},
        headers=auth_headers,
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_update_member_role(client, auth_headers):
    cr = await client.post("/teams", json={"name": "Roles"}, headers=auth_headers)
    team_id = cr.json()["id"]
    await _register(client, "member2@example.com")
    # Get user_id from member invite response
    inv = await client.post(
        f"/teams/{team_id}/members",
        json={"email": "member2@example.com", "role": "viewer"},
        headers=auth_headers,
    )
    user_id = inv.json()["user_id"]

    r = await client.patch(
        f"/teams/{team_id}/members/{user_id}",
        json={"role": "editor"},
        headers=auth_headers,
    )
    assert r.status_code == 200
    assert r.json()["role"] == "editor"


@pytest.mark.asyncio
async def test_cannot_demote_last_admin(client, auth_headers):
    cr = await client.post("/teams", json={"name": "Solo"}, headers=auth_headers)
    team_id = cr.json()["id"]
    admin_id = cr.json()["members"][0]["user_id"]

    r = await client.patch(
        f"/teams/{team_id}/members/{admin_id}",
        json={"role": "viewer"},
        headers=auth_headers,
    )
    assert r.status_code == 409


@pytest.mark.asyncio
async def test_remove_member(client, auth_headers):
    cr = await client.post("/teams", json={"name": "Remove"}, headers=auth_headers)
    team_id = cr.json()["id"]
    await _register(client, "leave@example.com")
    inv = await client.post(
        f"/teams/{team_id}/members",
        json={"email": "leave@example.com", "role": "viewer"},
        headers=auth_headers,
    )
    uid = inv.json()["user_id"]
    r = await client.delete(f"/teams/{team_id}/members/{uid}", headers=auth_headers)
    assert r.status_code == 204


# ── flow sharing ──────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_share_and_unshare_flow(client, auth_headers):
    from tests.conftest import MINIMAL_SPEC

    # Save a flow
    await client.post("/flows", json={"spec": MINIMAL_SPEC}, headers=auth_headers)
    flow_id = MINIMAL_SPEC["id"]

    # Create team
    cr = await client.post("/teams", json={"name": "SharedFlows"}, headers=auth_headers)
    team_id = cr.json()["id"]

    # Share
    r = await client.post(
        f"/teams/{team_id}/flows/{flow_id}",
        json={"permission": "view"},
        headers=auth_headers,
    )
    assert r.status_code == 201
    assert r.json()["permission"] == "view"

    # Unshare
    r2 = await client.delete(f"/teams/{team_id}/flows/{flow_id}", headers=auth_headers)
    assert r2.status_code == 204


@pytest.mark.asyncio
async def test_share_nonowned_flow_404(client, auth_headers):
    cr = await client.post("/teams", json={"name": "StealFlow"}, headers=auth_headers)
    team_id = cr.json()["id"]
    r = await client.post(
        f"/teams/{team_id}/flows/nonexistent-flow-id",
        json={"permission": "view"},
        headers=auth_headers,
    )
    assert r.status_code == 404


# ── Pass 1 additions ──────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_invalid_team_uuid_returns_422(client, auth_headers):
    """Non-UUID team_id must return 422, not 500."""
    r = await client.get("/teams/not-a-uuid", headers=auth_headers)
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_empty_team_name_rejected(client, auth_headers):
    r = await client.post("/teams", json={"name": "   "}, headers=auth_headers)
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_invite_cannot_demote_last_admin_via_reinvite(client, auth_headers):
    """Re-inviting the sole admin with a lower role must be rejected."""
    cr = await client.post("/teams", json={"name": "SoleAdmin"}, headers=auth_headers)
    team_id = cr.json()["id"]
    admin_email = cr.json()["members"][0]["email"]

    r = await client.post(
        f"/teams/{team_id}/members",
        json={"email": admin_email, "role": "viewer"},
        headers=auth_headers,
    )
    assert r.status_code == 409


@pytest.mark.asyncio
async def test_list_shared_flows(client, auth_headers):
    from tests.conftest import MINIMAL_SPEC

    await client.post("/flows", json={"spec": MINIMAL_SPEC}, headers=auth_headers)
    flow_id = MINIMAL_SPEC["id"]

    cr = await client.post("/teams", json={"name": "FlowLister"}, headers=auth_headers)
    team_id = cr.json()["id"]

    # Share the flow
    await client.post(
        f"/teams/{team_id}/flows/{flow_id}",
        json={"permission": "view"},
        headers=auth_headers,
    )

    r = await client.get(f"/teams/{team_id}/flows", headers=auth_headers)
    assert r.status_code == 200
    items = r.json()
    assert any(item["flow_id"] == flow_id for item in items)
    assert items[0]["permission"] == "view"


@pytest.mark.asyncio
async def test_list_shared_flows_empty(client, auth_headers):
    cr = await client.post("/teams", json={"name": "EmptyFlows"}, headers=auth_headers)
    team_id = cr.json()["id"]
    r = await client.get(f"/teams/{team_id}/flows", headers=auth_headers)
    assert r.status_code == 200
    assert r.json() == []


@pytest.mark.asyncio
async def test_list_shared_flows_non_member_forbidden(client, auth_headers):
    cr = await client.post("/teams", json={"name": "PrivateFlows"}, headers=auth_headers)
    team_id = cr.json()["id"]
    other_token = await _register(client, "outsider2@example.com")
    r = await client.get(
        f"/teams/{team_id}/flows", headers=_auth(other_token),
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_reinvite_returns_200_and_updates_role(client, auth_headers):
    """Re-inviting an existing member must return 200 and update their role."""
    cr = await client.post("/teams", json={"name": "ReInvite"}, headers=auth_headers)
    team_id = cr.json()["id"]
    await _register(client, "reinvitee@example.com")

    # First invite → 201
    r1 = await client.post(
        f"/teams/{team_id}/members",
        json={"email": "reinvitee@example.com", "role": "viewer"},
        headers=auth_headers,
    )
    assert r1.status_code == 201
    assert r1.json()["role"] == "viewer"

    # Re-invite with a different role → 200
    r2 = await client.post(
        f"/teams/{team_id}/members",
        json={"email": "reinvitee@example.com", "role": "editor"},
        headers=auth_headers,
    )
    assert r2.status_code == 200
    assert r2.json()["role"] == "editor"
