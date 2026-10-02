"""REST surface for agent memory: auth, owner scoping, structural gate, pending/undo/off."""

import pytest

from harness.agent_memory.store_sql import SqlMemoryStore


@pytest.fixture(autouse=True)
async def _memory_tables(db_engine, client):
    await SqlMemoryStore(db_engine).create_all()


@pytest.fixture
def audit_on(monkeypatch):
    monkeypatch.setenv("AUDIT_MEMORY_AUDIT_LOG", "1")


async def _second_user(client):
    r = await client.post("/auth/register", json={"email": "other@example.com", "password": "Password1"})
    assert r.status_code == 201, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


def _user(text, durable=True, **kw):
    return {"text": text, "durable": durable, "source": "user_asserted", **kw}


async def _record(client, headers, cands, **kw):
    r = await client.post("/memory/facts", json={"candidates": cands, **kw}, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


@pytest.mark.parametrize(
    "method,path",
    [
        ("GET", "/memory/facts"),
        ("GET", "/memory/render"),
        ("POST", "/memory/facts"),
        ("GET", "/memory/pending"),
        ("GET", "/memory/history"),
        ("GET", "/memory/export"),
        ("POST", "/memory/off"),
    ],
)
async def test_requires_auth(client, method, path):
    r = await client.request(method, path, json={} if method == "POST" else None)
    assert r.status_code in (401, 403)


async def test_record_list_render(client, auth_headers):
    out = await _record(client, auth_headers, [_user("The user's dentist is Dr. Okafor.")])
    assert out["outcomes"][0]["route"] == "durable"
    facts = (await client.get("/memory/facts", headers=auth_headers)).json()
    assert [f["text"] for f in facts["facts"]] == ["The user's dentist is Dr. Okafor."]
    assert facts["facts"][0]["extractedAt"]  # server-stamped
    block = (await client.get("/memory/render", headers=auth_headers)).json()
    assert "- The user's dentist is Dr. Okafor." in block["facts_block"]
    assert block["dropped_count"] == 0


async def test_owner_scoping_between_users(client, auth_headers):
    other = await _second_user(client)
    await _record(client, auth_headers, [_user("Secret-ish: likes jazz.")])
    mine = (await client.get("/memory/facts", headers=auth_headers)).json()["facts"]
    theirs = (await client.get("/memory/facts", headers=other)).json()["facts"]
    assert len(mine) == 1 and theirs == []
    assert (await client.get("/memory/export", headers=other)).json()["durable"] == []
    # forgetting by index in the other owner's space cannot touch mine
    assert (await client.delete("/memory/facts/0", headers=other)).status_code == 404
    assert len((await client.get("/memory/facts", headers=auth_headers)).json()["facts"]) == 1


async def test_org_scoping_separate_memory_per_org(client, auth_headers):
    created = await client.post("/orgs", json={"name": "Second org"}, headers=auth_headers)
    assert created.status_code == 201, created.text
    org_headers = {**auth_headers, "X-Org-ID": created.json()["id"]}
    await _record(client, auth_headers, [_user("personal-org fact")])
    assert (await client.get("/memory/facts", headers=org_headers)).json()["facts"] == []
    await _record(client, org_headers, [_user("second-org fact")])
    mine = (await client.get("/memory/facts", headers=auth_headers)).json()["facts"]
    assert [f["text"] for f in mine] == ["personal-org fact"]
    # a non-member cannot address someone else's org
    other = await _second_user(client)
    r = await client.get("/memory/facts", headers={**other, "X-Org-ID": created.json()["id"]})
    assert r.status_code == 401


async def test_record_rejects_non_user_asserted_when_gate_off(client, auth_headers):
    r = await client.post(
        "/memory/facts",
        json={"candidates": [_user("ok"), {"text": "model guess", "durable": True, "source": "model_inferred"}]},
        headers=auth_headers,
    )
    assert r.status_code == 403 and "[1]" in r.json()["detail"]
    r = await client.post(
        "/memory/facts",
        json={"candidates": [{"text": "from web", "durable": True, "source": "user_asserted", "origin": "web"}]},
        headers=auth_headers,
    )
    assert r.status_code == 403
    # nothing from the rejected request was stored (all-or-nothing)
    assert (await client.get("/memory/facts", headers=auth_headers)).json()["facts"] == []


async def test_gate_on_accepts_model_inferred_and_redacts(client, auth_headers, monkeypatch):
    monkeypatch.setenv("AUDIT_MEMORY_WRITE_GATE", "1")
    cand = {
        "text": "The user's password is hunter2.",
        "durable": True,
        "source": "model_inferred",
        "confidence": "high",
        "category": "other",
        "judgement": {
            "containsSecret": True,
            "redactedText": "The user has a password.",
            "looksLikeInstruction": False,
        },
    }
    out = await _record(client, auth_headers, [cand])
    stored = out["outcomes"][0]["fact"]
    assert "hunter2" not in stored["text"] and "judgement" not in stored
    export = (await client.get("/memory/export", headers=auth_headers)).json()
    assert "hunter2" not in str(export)


async def test_gate_on_missing_judgement_fails_closed_to_session(client, auth_headers, monkeypatch):
    monkeypatch.setenv("AUDIT_MEMORY_WRITE_GATE", "1")
    cand = {"text": "The user likes tea.", "durable": True, "source": "model_inferred", "confidence": "high"}
    out = await _record(client, auth_headers, [cand])
    assert out["outcomes"][0]["route"] == "session"
    assert (await client.get("/memory/export", headers=auth_headers)).json()["durable"] == []


async def test_validation_errors(client, auth_headers):
    bad = [
        {"candidates": []},
        {"candidates": [{"text": "", "durable": True}]},
        {"candidates": [{"text": "x", "source": "nonsense"}]},
        {"candidates": [{"text": "x", "category": "nonsense"}]},
        {"candidates": [{"text": "x", "retiredAt": "2020"}]},  # server-owned field
        {"candidates": [{"text": "x"}], "writer": "nobody"},
    ]
    for body in bad:
        r = await client.post("/memory/facts", json=body, headers=auth_headers)
        assert r.status_code == 422, (body, r.text)


async def test_forget(client, auth_headers):
    await _record(client, auth_headers, [_user("a fact"), _user("b fact")])
    r = await client.delete("/memory/facts/0", headers=auth_headers)
    assert r.status_code == 200 and r.json()["forgotten"]["text"] == "a fact"
    left = (await client.get("/memory/facts", headers=auth_headers)).json()["facts"]
    assert [f["text"] for f in left] == ["b fact"]
    assert (await client.delete("/memory/facts/5", headers=auth_headers)).status_code == 404


async def test_pending_confirm_and_reject(client, auth_headers, monkeypatch):
    monkeypatch.setenv("AUDIT_MEMORY_WRITE_GATE", "1")
    base = {"durable": True, "source": "model_inferred", "confidence": "medium"}
    j = {"containsSecret": False, "looksLikeInstruction": False}
    out = await _record(
        client,
        auth_headers,
        [{**base, "text": "likes cats", "judgement": j}, {**base, "text": "likes dogs", "judgement": j}],
    )
    assert [o["route"] for o in out["outcomes"]] == ["pending", "pending"]
    pend = (await client.get("/memory/pending", headers=auth_headers)).json()["pending"]
    assert [p["text"] for p in pend] == ["likes cats", "likes dogs"]

    r = await client.post("/memory/pending/0/confirm", headers=auth_headers)
    assert r.status_code == 200 and r.json()["confirmed"]["text"] == "likes cats"
    r = await client.post("/memory/pending/0/reject", headers=auth_headers)
    assert r.status_code == 200 and r.json()["rejected"]["text"] == "likes dogs"
    assert (await client.get("/memory/pending", headers=auth_headers)).json()["pending"] == []
    export = (await client.get("/memory/export", headers=auth_headers)).json()
    assert [f["text"] for f in export["durable"]] == ["likes cats"]
    assert [f["text"] for f in export["rejected"]] == ["likes dogs"]
    assert (await client.post("/memory/pending/3/confirm", headers=auth_headers)).status_code == 404
    assert (await client.post("/memory/pending/3/reject", headers=auth_headers)).status_code == 404


async def test_history_and_undo(client, auth_headers, audit_on):
    h = (await client.get("/memory/history", headers=auth_headers)).json()
    assert h == {"audit_log_enabled": True, "entries": []}
    await _record(client, auth_headers, [_user("keep me")])
    await client.delete("/memory/facts/0", headers=auth_headers)
    entries = (await client.get("/memory/history", headers=auth_headers)).json()["entries"]
    assert [e["op"] for e in entries] == ["add", "remove"]
    r = await client.post(f"/memory/history/{entries[1]['seq']}/undo", headers=auth_headers)
    assert r.json()["ok"] is True
    facts = (await client.get("/memory/facts", headers=auth_headers)).json()["facts"]
    assert [f["text"] for f in facts] == ["keep me"]
    again = (await client.post(f"/memory/history/{entries[1]['seq']}/undo", headers=auth_headers)).json()
    assert again["ok"] is False and again["message"]
    assert (await client.post("/memory/history/999/undo", headers=auth_headers)).json()["ok"] is False


async def test_history_is_owner_scoped(client, auth_headers, audit_on):
    other = await _second_user(client)
    await _record(client, auth_headers, [_user("mine")])
    assert (await client.get("/memory/history", headers=other)).json()["entries"] == []
    r = await client.post("/memory/history/1/undo", headers=other)
    assert r.json()["ok"] is False


async def test_off_and_on(client, auth_headers):
    assert (await client.get("/memory/status", headers=auth_headers)).json()["off"] is False
    assert (await client.post("/memory/off", headers=auth_headers)).json() == {"off": True}
    out = await _record(client, auth_headers, [_user("ignored while off")])
    assert out["blocked"] is True
    assert (await client.get("/memory/facts", headers=auth_headers)).json()["facts"] == []
    await client.post("/memory/on", headers=auth_headers)
    out = await _record(client, auth_headers, [_user("kept now")])
    assert out["blocked"] is False and out["outcomes"][0]["route"] == "durable"


async def test_off_is_per_owner(client, auth_headers):
    other = await _second_user(client)
    await client.post("/memory/off", headers=auth_headers)
    assert (await client.get("/memory/status", headers=other)).json()["off"] is False
