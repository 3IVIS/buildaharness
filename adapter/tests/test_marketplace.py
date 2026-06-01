"""
Tests for the component marketplace API.

Covered:
  GET  /marketplace                  — empty list; with seed data; ?q= search; ?category= filter; ?verified= filter
  GET  /marketplace/{slug}           — 200 on existing; 404 on unknown
  POST /marketplace                  — 201 on valid publish; 409 on duplicate slug; 401 without auth
  POST /marketplace/{slug}/install   — 200 returns node_spec + tool_def + tool_id; 404 on unknown; 401 without auth
  install increments install_count
  seed_marketplace() is a no-op under TESTING=true (env gated)
"""

import pytest

# ── Helpers ───────────────────────────────────────────────────────────────────


async def _register(client, email: str, password: str = "Password1") -> dict:
    r = await client.post("/auth/register", json={"email": email, "password": password})
    assert r.status_code == 201, r.text
    return r.json()


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# Minimal valid publish payload
PUBLISH_PAYLOAD = {
    "slug": "my-custom-tool",
    "name": "My Custom Tool",
    "description": "Does something useful",
    "category": "tool",
    "icon_emoji": "🛠️",
    "npm_ref": "@acme/custom-tool",
    "source": "npm",
    "node_spec": {"type": "tool_invoke", "tool_id": "my_custom_tool", "data": {"label": "My Custom Tool"}},
    "tool_def": {"tool_ref": "@acme/custom-tool", "source": "npm", "description": "Does something"},
    "tags": ["custom", "acme"],
}


# ── GET /marketplace ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_marketplace_list_empty(client):
    """Returns empty list when no components exist (TESTING=true skips seeder)."""
    r = await client.get("/marketplace")
    assert r.status_code == 200
    assert r.json() == []


@pytest.mark.asyncio
async def test_marketplace_list_public_no_auth(client):
    """GET /marketplace is accessible without a JWT."""
    r = await client.get("/marketplace")
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_marketplace_list_after_publish(client):
    creds = await _register(client, "mkt-list@test.com")
    h = _auth(creds["token"])
    await client.post("/marketplace", json=PUBLISH_PAYLOAD, headers=h)

    r = await client.get("/marketplace")
    assert r.status_code == 200
    items = r.json()
    assert len(items) == 1
    assert items[0]["slug"] == "my-custom-tool"
    assert items[0]["name"] == "My Custom Tool"
    assert items[0]["verified"] is False  # user-published = not verified


@pytest.mark.asyncio
async def test_marketplace_search_by_name(client):
    creds = await _register(client, "mkt-search@test.com")
    h = _auth(creds["token"])
    await client.post("/marketplace", json=PUBLISH_PAYLOAD, headers=h)

    r = await client.get("/marketplace?q=custom")
    assert r.status_code == 200
    assert len(r.json()) == 1

    r2 = await client.get("/marketplace?q=zzznomatch")
    assert r2.status_code == 200
    assert r2.json() == []


@pytest.mark.asyncio
async def test_marketplace_filter_category(client):
    creds = await _register(client, "mkt-cat@test.com")
    h = _auth(creds["token"])
    await client.post("/marketplace", json=PUBLISH_PAYLOAD, headers=h)

    r = await client.get("/marketplace?category=tool")
    assert r.status_code == 200
    assert len(r.json()) == 1

    r2 = await client.get("/marketplace?category=agent")
    assert r2.status_code == 200
    assert r2.json() == []


@pytest.mark.asyncio
async def test_marketplace_filter_verified(client):
    creds = await _register(client, "mkt-ver@test.com")
    h = _auth(creds["token"])
    await client.post("/marketplace", json=PUBLISH_PAYLOAD, headers=h)

    # user-published = not verified
    r = await client.get("/marketplace?verified=true")
    assert r.status_code == 200
    assert r.json() == []

    r2 = await client.get("/marketplace?verified=false")
    assert r2.status_code == 200
    assert len(r2.json()) == 1


# ── GET /marketplace/{slug} ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_marketplace_get_404(client):
    r = await client.get("/marketplace/does-not-exist")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_marketplace_get_200(client):
    creds = await _register(client, "mkt-get@test.com")
    h = _auth(creds["token"])
    await client.post("/marketplace", json=PUBLISH_PAYLOAD, headers=h)

    r = await client.get("/marketplace/my-custom-tool")
    assert r.status_code == 200
    body = r.json()
    assert body["slug"] == "my-custom-tool"
    assert body["node_spec"] == PUBLISH_PAYLOAD["node_spec"]
    assert body["tool_def"] == PUBLISH_PAYLOAD["tool_def"]
    assert "created_at" in body


@pytest.mark.asyncio
async def test_marketplace_get_public_no_auth(client):
    creds = await _register(client, "mkt-pubget@test.com")
    h = _auth(creds["token"])
    await client.post("/marketplace", json=PUBLISH_PAYLOAD, headers=h)

    r = await client.get("/marketplace/my-custom-tool")
    assert r.status_code == 200


# ── POST /marketplace ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_marketplace_publish_201(client):
    creds = await _register(client, "mkt-pub@test.com")
    r = await client.post("/marketplace", json=PUBLISH_PAYLOAD, headers=_auth(creds["token"]))
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["slug"] == "my-custom-tool"
    assert body["verified"] is False


@pytest.mark.asyncio
async def test_marketplace_publish_401_no_auth(client):
    r = await client.post("/marketplace", json=PUBLISH_PAYLOAD)
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_marketplace_publish_409_duplicate_slug(client):
    creds = await _register(client, "mkt-dup@test.com")
    h = _auth(creds["token"])
    r1 = await client.post("/marketplace", json=PUBLISH_PAYLOAD, headers=h)
    assert r1.status_code == 201
    r2 = await client.post("/marketplace", json=PUBLISH_PAYLOAD, headers=h)
    assert r2.status_code == 409


@pytest.mark.asyncio
async def test_marketplace_publish_invalid_slug(client):
    creds = await _register(client, "mkt-slug@test.com")
    h = _auth(creds["token"])
    bad = {**PUBLISH_PAYLOAD, "slug": "Bad Slug!"}
    r = await client.post("/marketplace", json=bad, headers=h)
    assert r.status_code == 422  # Pydantic pattern validation


@pytest.mark.asyncio
async def test_marketplace_publish_invalid_category(client):
    creds = await _register(client, "mkt-catv@test.com")
    h = _auth(creds["token"])
    bad = {**PUBLISH_PAYLOAD, "slug": "valid-slug", "category": "unknown"}
    r = await client.post("/marketplace", json=bad, headers=h)
    assert r.status_code == 422


# ── POST /marketplace/{slug}/install ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_marketplace_install_404(client):
    creds = await _register(client, "mkt-inst1@test.com")
    r = await client.post("/marketplace/ghost-slug/install", headers=_auth(creds["token"]))
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_marketplace_install_401_no_auth(client):
    creds = await _register(client, "mkt-inst2@test.com")
    h = _auth(creds["token"])
    await client.post("/marketplace", json=PUBLISH_PAYLOAD, headers=h)
    r = await client.post("/marketplace/my-custom-tool/install")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_marketplace_install_200_returns_fragments(client):
    creds = await _register(client, "mkt-inst3@test.com")
    h = _auth(creds["token"])
    await client.post("/marketplace", json=PUBLISH_PAYLOAD, headers=h)

    r = await client.post("/marketplace/my-custom-tool/install", headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["slug"] == "my-custom-tool"
    assert body["name"] == "My Custom Tool"
    assert body["node_spec"] == PUBLISH_PAYLOAD["node_spec"]
    assert body["tool_def"] == PUBLISH_PAYLOAD["tool_def"]
    assert body["tool_id"] == "my_custom_tool"  # hyphens → underscores


@pytest.mark.asyncio
async def test_marketplace_install_increments_count(client):
    creds = await _register(client, "mkt-inst4@test.com")
    h = _auth(creds["token"])
    await client.post("/marketplace", json=PUBLISH_PAYLOAD, headers=h)

    await client.post("/marketplace/my-custom-tool/install", headers=h)
    await client.post("/marketplace/my-custom-tool/install", headers=h)

    r = await client.get("/marketplace/my-custom-tool")
    assert r.json()["install_count"] == 2


@pytest.mark.asyncio
async def test_marketplace_install_tool_id_derivation(client):
    """Slugs with hyphens become underscored tool_ids."""
    creds = await _register(client, "mkt-inst5@test.com")
    h = _auth(creds["token"])
    payload = {**PUBLISH_PAYLOAD, "slug": "multi-word-slug"}
    await client.post("/marketplace", json=payload, headers=h)

    r = await client.post("/marketplace/multi-word-slug/install", headers=h)
    assert r.json()["tool_id"] == "multi_word_slug"


# ── Pagination ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_marketplace_pagination(client):
    creds = await _register(client, "mkt-page@test.com")
    h = _auth(creds["token"])

    # Publish 3 components with distinct slugs
    for i in range(3):
        p = {**PUBLISH_PAYLOAD, "slug": f"paged-tool-{i}"}
        await client.post("/marketplace", json=p, headers=h)

    r_all = await client.get("/marketplace?limit=10")
    assert len(r_all.json()) == 3

    r_page = await client.get("/marketplace?limit=2&offset=0")
    assert len(r_page.json()) == 2

    r_rest = await client.get("/marketplace?limit=2&offset=2")
    assert len(r_rest.json()) == 1
