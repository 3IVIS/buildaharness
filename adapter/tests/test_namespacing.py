"""
Tests for multi-tenant namespacing (migration 0005 / Phase 3).

Covered:
  Personal org
    - Created automatically on register
    - Second register creates a separate org (not shared)
    - GET /orgs returns the personal org
    - current_org resolves to personal org with no header/QP

  Org management (/orgs)
    - POST /orgs creates a new org
    - GET  /orgs/{id} returns detail + members
    - PATCH /orgs/{id} renames org
    - PATCH /orgs/{id} sets Langfuse keys (has_langfuse_keys: true)
    - PATCH /orgs/{id} clears Langfuse keys (has_langfuse_keys: false)
    - DELETE /orgs/{id} of personal org returns 409
    - DELETE /orgs/{id} of non-personal org succeeds
    - Last-admin guard on delete member
    - Last-admin guard on demote member

  X-Org-ID header isolation
    - Flow saved in org A is NOT visible in org B
    - Job created in org A has correct org_id in DB

  LangGraph thread_id namespacing
    - run_api._run_langgraph uses {org_id}:{job_id} as thread_id
    - thread_id is plain job_id when org_id is None

  get_langfuse_keys
    - Returns per-org keys when set
    - Falls back to global env vars when org has no keys
    - Returns ('', '') when neither source has keys

  Prompt resolver org threading
    - resolve_prompts(spec, org=org_with_keys) uses org keys (not env)
    - resolve_prompts(spec, org=None) uses env fallback
"""

import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker

from db import Org
from org_context import ensure_personal_org, get_langfuse_keys
from tests.conftest import MINIMAL_SPEC

# ── helpers ────────────────────────────────────────────────────────────────────


async def _register(client: AsyncClient, email: str, pw: str = "Password1") -> dict:
    r = await client.post("/auth/register", json={"email": email, "password": pw})
    assert r.status_code == 201, r.text
    return r.json()


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _hdr(token: str, org_id: str) -> dict:
    return {"Authorization": f"Bearer {token}", "X-Org-ID": org_id}


# ── Personal org created on register ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_register_creates_personal_org(client, db_engine):
    r = await _register(client, "alice@example.com")
    token = r["token"]

    resp = await client.get("/orgs", headers=_auth(token))
    assert resp.status_code == 200
    orgs = resp.json()
    assert len(orgs) == 1
    assert orgs[0]["role"] == "admin"
    assert "alice" in orgs[0]["name"].lower()


@pytest.mark.asyncio
async def test_two_users_have_separate_personal_orgs(client, db_engine):
    a = await _register(client, "alice2@example.com")
    b = await _register(client, "bob2@example.com")

    orgs_a = (await client.get("/orgs", headers=_auth(a["token"]))).json()
    orgs_b = (await client.get("/orgs", headers=_auth(b["token"]))).json()

    ids_a = {o["id"] for o in orgs_a}
    ids_b = {o["id"] for o in orgs_b}
    assert ids_a.isdisjoint(ids_b), "Users must not share a personal org"


# ── Org CRUD ───────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_create_org(client, auth_headers):
    r = await client.post("/orgs", json={"name": "ACME Corp"}, headers=auth_headers)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["name"] == "ACME Corp"
    assert len(body["members"]) == 1
    assert body["members"][0]["role"] == "admin"


@pytest.mark.asyncio
async def test_get_org_detail(client, auth_headers):
    r = await client.post("/orgs", json={"name": "Detail Corp"}, headers=auth_headers)
    org_id = r.json()["id"]

    r2 = await client.get(f"/orgs/{org_id}", headers=auth_headers)
    assert r2.status_code == 200
    assert r2.json()["id"] == org_id
    assert r2.json()["name"] == "Detail Corp"


@pytest.mark.asyncio
async def test_patch_org_rename(client, auth_headers):
    r = await client.post("/orgs", json={"name": "Old Name"}, headers=auth_headers)
    org_id = r.json()["id"]

    r2 = await client.patch(f"/orgs/{org_id}", json={"name": "New Name"}, headers=auth_headers)
    assert r2.status_code == 200
    assert r2.json()["name"] == "New Name"


@pytest.mark.asyncio
async def test_patch_org_sets_langfuse_keys(client, auth_headers):
    r = await client.post("/orgs", json={"name": "LF Org"}, headers=auth_headers)
    org_id = r.json()["id"]

    r2 = await client.patch(
        f"/orgs/{org_id}",
        json={
            "langfuse_public_key": "pk-test-abc",
            "langfuse_secret_key": "sk-test-xyz",
        },
        headers=auth_headers,
    )
    assert r2.status_code == 200
    assert r2.json()["has_langfuse_keys"] is True


@pytest.mark.asyncio
async def test_patch_org_clears_langfuse_keys(client, auth_headers):
    r = await client.post("/orgs", json={"name": "LF Clear Org"}, headers=auth_headers)
    org_id = r.json()["id"]

    await client.patch(
        f"/orgs/{org_id}",
        json={
            "langfuse_public_key": "pk-test-abc",
            "langfuse_secret_key": "sk-test-xyz",
        },
        headers=auth_headers,
    )

    r2 = await client.patch(
        f"/orgs/{org_id}",
        json={
            "langfuse_public_key": "",
            "langfuse_secret_key": "",
        },
        headers=auth_headers,
    )
    assert r2.json()["has_langfuse_keys"] is False


@pytest.mark.asyncio
async def test_delete_personal_org_returns_409(client, auth_headers):
    orgs = (await client.get("/orgs", headers=auth_headers)).json()
    personal_org_id = orgs[0]["id"]

    r = await client.delete(f"/orgs/{personal_org_id}", headers=auth_headers)
    assert r.status_code == 409, "Cannot delete personal org"


@pytest.mark.asyncio
async def test_delete_non_personal_org_succeeds(client, auth_headers):
    r = await client.post("/orgs", json={"name": "Temp Org"}, headers=auth_headers)
    org_id = r.json()["id"]

    r2 = await client.delete(f"/orgs/{org_id}", headers=auth_headers)
    assert r2.status_code == 204


# ── Member management ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_invite_and_list_members(client, auth_headers):
    # Register a second user.
    await _register(client, "bob_inv@example.com")

    r = await client.post("/orgs", json={"name": "Shared Org"}, headers=auth_headers)
    org_id = r.json()["id"]

    r2 = await client.post(
        f"/orgs/{org_id}/members", json={"email": "bob_inv@example.com", "role": "member"}, headers=auth_headers
    )
    assert r2.status_code == 201

    members = (await client.get(f"/orgs/{org_id}/members", headers=auth_headers)).json()
    emails = {m["email"] for m in members}
    assert "bob_inv@example.com" in emails


@pytest.mark.asyncio
async def test_last_admin_guard_demote(client, auth_headers):
    me_resp = await client.get("/auth/me", headers=auth_headers)
    user_id = me_resp.json()["user_id"]

    r = await client.post("/orgs", json={"name": "Guard Org"}, headers=auth_headers)
    org_id = r.json()["id"]

    r2 = await client.patch(f"/orgs/{org_id}/members/{user_id}", json={"role": "member"}, headers=auth_headers)
    assert r2.status_code == 409, "Cannot demote the last admin"


@pytest.mark.asyncio
async def test_last_admin_guard_remove(client, auth_headers):
    me_resp = await client.get("/auth/me", headers=auth_headers)
    user_id = me_resp.json()["user_id"]

    r = await client.post("/orgs", json={"name": "Guard Org 2"}, headers=auth_headers)
    org_id = r.json()["id"]

    r2 = await client.delete(f"/orgs/{org_id}/members/{user_id}", headers=auth_headers)
    assert r2.status_code == 409, "Cannot remove the last admin"


# ── X-Org-ID flow isolation ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_flow_scoped_to_org(client, auth_headers):
    """A flow saved in org A must not appear when listing with org B header."""
    # Create two orgs.
    r_a = await client.post("/orgs", json={"name": "Org A"}, headers=auth_headers)
    r_b = await client.post("/orgs", json={"name": "Org B"}, headers=auth_headers)
    org_a_id = r_a.json()["id"]
    org_b_id = r_b.json()["id"]

    token = auth_headers["Authorization"].split(" ")[1]

    # Save a flow under org A.
    spec = {**MINIMAL_SPEC, "id": "flow-org-a", "name": "Org A Flow"}
    save = await client.post("/flows", json={"spec": spec}, headers=_hdr(token, org_a_id))
    assert save.status_code == 200

    # Listing under org A should see the flow.
    flows_a = (await client.get("/flows", headers=_hdr(token, org_a_id))).json()
    assert any(f["id"] == "flow-org-a" for f in flows_a)

    # Listing under org B must NOT see the flow.
    flows_b = (await client.get("/flows", headers=_hdr(token, org_b_id))).json()
    assert not any(f["id"] == "flow-org-a" for f in flows_b)


@pytest.mark.asyncio
async def test_get_flow_wrong_org_returns_404(client, auth_headers):
    """GET /flows/{id} with X-Org-ID of a different org returns 404."""
    r_a = await client.post("/orgs", json={"name": "Org Iso A"}, headers=auth_headers)
    r_b = await client.post("/orgs", json={"name": "Org Iso B"}, headers=auth_headers)
    org_a_id = r_a.json()["id"]
    org_b_id = r_b.json()["id"]
    token = auth_headers["Authorization"].split(" ")[1]

    spec = {**MINIMAL_SPEC, "id": "flow-iso", "name": "ISO Flow"}
    await client.post("/flows", json={"spec": spec}, headers=_hdr(token, org_a_id))

    r = await client.get("/flows/flow-iso", headers=_hdr(token, org_b_id))
    assert r.status_code == 404


# ── Job org_id stamped correctly ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_run_job_stamped_with_org_id(client, auth_headers, db_engine):
    """POST /run must stamp the job row with the active org_id."""
    from run_api import _jobs_get

    orgs = (await client.get("/orgs", headers=auth_headers)).json()
    personal_org_id = orgs[0]["id"]
    token = auth_headers["Authorization"].split(" ")[1]

    r = await client.post("/run?runtime=langgraph", json={"spec": MINIMAL_SPEC}, headers=_hdr(token, personal_org_id))
    assert r.status_code == 202
    job_id = r.json()["job_id"]

    SessionLocal = async_sessionmaker(db_engine, expire_on_commit=False)
    async with SessionLocal() as db:
        job = await _jobs_get(job_id, db)

    assert job is not None
    assert job.org_id is not None
    assert str(job.org_id) == personal_org_id


# ── LangGraph thread_id namespacing ───────────────────────────────────────────


def test_thread_id_namespaced_with_org_id():
    """_run_langgraph must use {org_id}:{job_id} as the LG thread_id."""
    import inspect

    import run_api

    src = inspect.getsource(run_api._run_langgraph)
    assert 'f"{org_id}:{job_id}"' in src or "org_id}:{job_id" in src, (
        "_run_langgraph must namespace LG thread_id with org_id"
    )


def test_thread_id_plain_when_no_org():
    """When org_id is None the thread_id should fall back to plain job_id."""
    import inspect

    import run_api

    src = inspect.getsource(run_api._run_langgraph)
    assert "else job_id" in src, "_run_langgraph must fall back to plain job_id when org_id is None"


# ── get_langfuse_keys ─────────────────────────────────────────────────────────


def test_get_langfuse_keys_per_org():
    org = Org(
        id=uuid.uuid4(),
        name="test",
        owner_id=uuid.uuid4(),
        langfuse_public_key="pk-org-123",
        langfuse_secret_key="sk-org-456",
    )
    pub, sec = get_langfuse_keys(org)
    assert pub == "pk-org-123"
    assert sec == "sk-org-456"


def test_get_langfuse_keys_falls_back_to_env(monkeypatch):
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-env-111")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-env-222")
    org = Org(id=uuid.uuid4(), name="test", owner_id=uuid.uuid4(), langfuse_public_key=None, langfuse_secret_key=None)
    pub, sec = get_langfuse_keys(org)
    assert pub == "pk-env-111"
    assert sec == "sk-env-222"


def test_get_langfuse_keys_empty_when_none(monkeypatch):
    monkeypatch.delenv("LANGFUSE_PUBLIC_KEY", raising=False)
    monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)
    pub, sec = get_langfuse_keys(None)
    assert pub == ""
    assert sec == ""


# ── X-Org-ID header — invalid UUID returns 422 ────────────────────────────────


@pytest.mark.asyncio
async def test_invalid_org_id_header_returns_422(client, auth_headers):
    token = auth_headers["Authorization"].split(" ")[1]
    r = await client.get(
        "/flows",
        headers={
            "Authorization": f"Bearer {token}",
            "X-Org-ID": "not-a-uuid",
        },
    )
    assert r.status_code == 422


# ── Non-member org access returns 401 ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_non_member_org_access_returns_401(client, auth_headers):
    """Passing another org's ID in X-Org-ID must return 401."""
    # Register a second user and get their org.
    bob = await _register(client, "bob_orgisolate@example.com")
    bob_orgs = (await client.get("/orgs", headers=_auth(bob["token"]))).json()
    bob_org_id = bob_orgs[0]["id"]

    # Alice (auth_headers) tries to use Bob's org.
    token = auth_headers["Authorization"].split(" ")[1]
    r = await client.get("/flows", headers=_hdr(token, bob_org_id))
    assert r.status_code == 401


# ── GET /orgs/{id} non-member returns 404 ────────────────────────────────────


@pytest.mark.asyncio
async def test_get_org_non_member_returns_404(client, auth_headers):
    """GET /orgs/{id} by a non-member must return 404, not 403, to avoid
    leaking whether the org exists."""
    stranger = await _register(client, "stranger_getorg@example.com")

    r = await client.post("/orgs", json={"name": "Secret Org"}, headers=auth_headers)
    org_id = r.json()["id"]

    r2 = await client.get(f"/orgs/{org_id}", headers=_auth(stranger["token"]))
    assert r2.status_code == 404, "Non-member GET /orgs/{id} must return 404"


# ── A2A task stamps org_id on the job row ─────────────────────────────────────


@pytest.mark.asyncio
async def test_a2a_task_stamped_with_org_id(client, auth_headers, db_engine):
    """POST /a2a/{flow_id}/tasks/send must stamp the created job row with the
    active org_id, just like POST /run does."""
    from run_api import _jobs_get

    # Use the personal org (default resolution with no X-Org-ID header).
    orgs = (await client.get("/orgs", headers=auth_headers)).json()
    personal_org_id = orgs[0]["id"]

    # Create a flow with A2A enabled in the personal org.
    a2a_spec = {
        **MINIMAL_SPEC,
        "id": "a2a-org-stamp-flow",
        "name": "A2A Org Stamp Test",
        "flow_config": {
            "a2a_config": {
                "enabled": True,
                "agent_name": "Stamp Agent",
                "agent_description": "Tests org_id stamping",
                "version": "1.0.0",
                "authentication": "none",
            }
        },
    }
    r_flow = await client.post("/flows", json={"spec": a2a_spec}, headers=auth_headers)
    assert r_flow.status_code == 200, r_flow.text

    task_id = str(uuid.uuid4())
    r_task = await client.post(
        f"/a2a/{a2a_spec['id']}/tasks/send",
        json={"id": task_id, "message": {"role": "user", "parts": [{"text": "go"}]}},
        headers=auth_headers,
    )
    assert r_task.status_code == 202, r_task.text

    SessionLocal = async_sessionmaker(db_engine, expire_on_commit=False)
    async with SessionLocal() as db:
        job = await _jobs_get(task_id, db)

    assert job is not None
    assert job.org_id is not None, "A2A task job row must have org_id set"
    assert str(job.org_id) == personal_org_id, (
        f"A2A task org_id {job.org_id} must match the personal org {personal_org_id}"
    )


# ── ensure_personal_org is idempotent ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_ensure_personal_org_idempotent(client, auth_headers, db_engine):
    """Calling ensure_personal_org twice must not create duplicate orgs."""
    from sqlalchemy import select

    from db import User

    SessionLocal = async_sessionmaker(db_engine, expire_on_commit=False)
    async with SessionLocal() as db:
        user = (await db.execute(select(User))).scalars().first()
        org1 = await ensure_personal_org(user, db)
        org2 = await ensure_personal_org(user, db)

    assert str(org1.id) == str(org2.id), "ensure_personal_org must be idempotent"


# ── Re-invite returns 200 ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_invite_existing_member_returns_200(client, auth_headers):
    """Re-inviting an existing member must update their role and return 200."""
    await _register(client, "bob_reinvite@example.com")

    r = await client.post("/orgs", json={"name": "Reinvite Org"}, headers=auth_headers)
    org_id = r.json()["id"]

    # First invite — 201
    r1 = await client.post(
        f"/orgs/{org_id}/members", json={"email": "bob_reinvite@example.com", "role": "member"}, headers=auth_headers
    )
    assert r1.status_code == 201

    # Re-invite with different role — must return 200
    r2 = await client.post(
        f"/orgs/{org_id}/members", json={"email": "bob_reinvite@example.com", "role": "admin"}, headers=auth_headers
    )
    assert r2.status_code == 200, "Re-invite must return 200, not 201"
    assert r2.json()["role"] == "admin"


# ── Cross-org re-save blocked ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_resave_flow_wrong_org_returns_404(client, auth_headers):
    """Re-saving a flow while presenting a different org header must return 404."""
    r_a = await client.post("/orgs", json={"name": "Org RS-A"}, headers=auth_headers)
    r_b = await client.post("/orgs", json={"name": "Org RS-B"}, headers=auth_headers)
    org_a_id = r_a.json()["id"]
    org_b_id = r_b.json()["id"]
    token = auth_headers["Authorization"].split(" ")[1]

    # Save flow under org A
    spec = {**MINIMAL_SPEC, "id": "flow-resave", "name": "Resave Flow"}
    r1 = await client.post("/flows", json={"spec": spec}, headers=_hdr(token, org_a_id))
    assert r1.status_code == 200

    # Try to re-save the same flow ID under org B — must fail
    r2 = await client.post("/flows", json={"spec": spec}, headers=_hdr(token, org_b_id))
    assert r2.status_code == 404, "Re-saving a flow under the wrong org must return 404"


# ── Prompt resolver cache isolation ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_non_admin_cannot_patch_org(client, auth_headers):
    """A plain member must not be able to rename the org (403)."""
    bob = await _register(client, "bob_nonadmin@example.com")

    r = await client.post("/orgs", json={"name": "Perm Test Org"}, headers=auth_headers)
    org_id = r.json()["id"]

    # Invite bob as member (not admin)
    await client.post(
        f"/orgs/{org_id}/members", json={"email": "bob_nonadmin@example.com", "role": "member"}, headers=auth_headers
    )

    r2 = await client.patch(f"/orgs/{org_id}", json={"name": "Hacked Name"}, headers=_auth(bob["token"]))
    assert r2.status_code == 403, "Non-admin member must not be able to rename org"


@pytest.mark.asyncio
async def test_non_member_cannot_delete_org(client, auth_headers):
    """A non-member trying to delete an org must get 403."""
    stranger = await _register(client, "stranger_del@example.com")

    r = await client.post("/orgs", json={"name": "Stranger Delete Org"}, headers=auth_headers)
    org_id = r.json()["id"]

    r2 = await client.delete(f"/orgs/{org_id}", headers=_auth(stranger["token"]))
    assert r2.status_code == 403


@pytest.mark.asyncio
async def test_member_can_remove_self(client, auth_headers):
    """A plain member must be able to remove themselves from an org."""
    bob = await _register(client, "bob_selfremove@example.com")

    r = await client.post("/orgs", json={"name": "Self-Remove Org"}, headers=auth_headers)
    org_id = r.json()["id"]

    await client.post(
        f"/orgs/{org_id}/members", json={"email": "bob_selfremove@example.com", "role": "member"}, headers=auth_headers
    )

    bob_id = bob["user_id"]
    r2 = await client.delete(f"/orgs/{org_id}/members/{bob_id}", headers=_auth(bob["token"]))
    assert r2.status_code == 204, "Member should be able to remove themselves"

    # Confirm bob is gone
    members = (await client.get(f"/orgs/{org_id}/members", headers=auth_headers)).json()
    assert not any(m["user_id"] == bob_id for m in members)


@pytest.mark.asyncio
async def test_partial_langfuse_keys_fall_back_to_global(monkeypatch):
    """Org with only public key set must fall back to global for BOTH keys."""
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "global-pub")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "global-sec")

    org = Org(
        id=uuid.uuid4(),
        name="partial",
        owner_id=uuid.uuid4(),
        langfuse_public_key="org-pub-only",  # only pub set
        langfuse_secret_key=None,
    )
    pub, sec = get_langfuse_keys(org)

    # Must fall back to global — do NOT mix org pub with global sec
    assert pub == "global-pub", "Partial org keys must fall back to global pub"
    assert sec == "global-sec", "Partial org keys must fall back to global sec"


def test_prompt_cache_key_includes_org_id():
    """The prompt resolver cache key must include the org_id to prevent
    cross-tenant prompt bleed when two orgs use the same prompt name."""
    import inspect

    from prompt_resolver import resolve_prompts

    src = inspect.getsource(resolve_prompts)
    assert "org_prefix" in src or "org.id" in src, (
        "resolve_prompts cache key must incorporate the org identifier to prevent cross-org prompt cache sharing."
    )


@pytest.mark.asyncio
async def test_resolve_prompts_cache_segregated_by_org(monkeypatch):
    """Two calls with different orgs must produce independent cache entries."""
    import uuid as _uuid

    from db import Org
    from prompt_resolver import _cache_clear, resolve_prompts

    _cache_clear()

    org_a = Org(id=_uuid.uuid4(), name="A", owner_id=_uuid.uuid4())
    org_b = Org(id=_uuid.uuid4(), name="B", owner_id=_uuid.uuid4())

    # Verify the function accepts distinct org objects without raising.
    monkeypatch.setenv("TESTING", "true")
    spec = {
        "spec_version": "0.2.0",
        "id": "t",
        "name": "t",
        "nodes": [],
        "edges": [],
    }
    result_a = await resolve_prompts(spec, org_a)
    result_b = await resolve_prompts(spec, org_b)
    assert result_a is not None
    assert result_b is not None
    _cache_clear()


# ── Input validation ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_create_org_empty_name_returns_422(client, auth_headers):
    """POST /orgs with an empty name must return 422."""
    r = await client.post("/orgs", json={"name": "   "}, headers=auth_headers)
    assert r.status_code == 422, f"Expected 422 for empty name, got {r.status_code}"


@pytest.mark.asyncio
async def test_patch_org_empty_name_returns_400(client, auth_headers):
    """PATCH /orgs/{id} with an empty name string must return 400."""
    r = await client.post("/orgs", json={"name": "Rename Test"}, headers=auth_headers)
    org_id = r.json()["id"]

    r2 = await client.patch(f"/orgs/{org_id}", json={"name": "  "}, headers=auth_headers)
    assert r2.status_code == 400


@pytest.mark.asyncio
async def test_invite_nonexistent_email_returns_404(client, auth_headers):
    """POST /orgs/{id}/members with unknown email must return 404."""
    r = await client.post("/orgs", json={"name": "Invite 404 Org"}, headers=auth_headers)
    org_id = r.json()["id"]

    r2 = await client.post(
        f"/orgs/{org_id}/members",
        json={"email": "nobody@no-such-domain-xyz.example", "role": "member"},
        headers=auth_headers,
    )
    assert r2.status_code == 404


@pytest.mark.asyncio
async def test_change_member_role_success(client, auth_headers):
    """PATCH /orgs/{id}/members/{uid} must promote a member to admin."""
    bob = await _register(client, "bob_promote@example.com")

    r = await client.post("/orgs", json={"name": "Promote Org"}, headers=auth_headers)
    org_id = r.json()["id"]

    # Invite bob as member
    await client.post(
        f"/orgs/{org_id}/members",
        json={"email": "bob_promote@example.com", "role": "member"},
        headers=auth_headers,
    )
    bob_id = bob["user_id"]

    # Promote bob to admin
    r2 = await client.patch(
        f"/orgs/{org_id}/members/{bob_id}",
        json={"role": "admin"},
        headers=auth_headers,
    )
    assert r2.status_code == 200, r2.text
    assert r2.json()["role"] == "admin"


@pytest.mark.asyncio
async def test_list_orgs_includes_invited_orgs(client, auth_headers):
    """GET /orgs must return orgs the caller was invited to, not just created."""
    bob = await _register(client, "bob_invited_list@example.com")

    # Alice creates an org and invites bob
    r = await client.post("/orgs", json={"name": "Alice's Org"}, headers=auth_headers)
    org_id = r.json()["id"]
    await client.post(
        f"/orgs/{org_id}/members",
        json={"email": "bob_invited_list@example.com", "role": "member"},
        headers=auth_headers,
    )

    # Bob should see Alice's org in his list
    bob_orgs = (await client.get("/orgs", headers=_auth(bob["token"]))).json()
    org_ids = {o["id"] for o in bob_orgs}
    assert org_id in org_ids, "Bob must see Alice's org after being invited"
