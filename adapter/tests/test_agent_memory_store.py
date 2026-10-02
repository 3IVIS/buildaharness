"""MemoryStore behaviour shared by the in-memory and SQL stores (in-memory SQLite, no stack)."""

import asyncio

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import create_async_engine

from harness.agent_memory.store_memory import InMemoryMemoryStore
from harness.agent_memory.store_sql import SqlMemoryStore

OWNER = "org-1:user-1"
OTHER = "org-1:user-2"


def fact(text: str, at: str = "2026-01-01T00:00:00.000Z", **kw):
    return {"text": text, "extractedAt": at, "sourceTurn": "s1", "durable": True, "source": "user_asserted", **kw}


def entry(seq: int, op: str = "add"):
    return {"seq": seq, "at": f"2026-01-01T00:00:{seq:02d}.000Z", "op": op, "factId": f"f{seq}", "store": "durable"}


@pytest_asyncio.fixture(params=["memory", "sql"])
async def store(request):
    if request.param == "memory":
        yield InMemoryMemoryStore()
        return
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    s = SqlMemoryStore(engine)
    await s.create_all()
    yield s
    await engine.dispose()


async def test_absent_vs_empty_list(store):
    assert await store.get_list(OWNER, "facts:durable") is None
    await store.set_list(OWNER, "facts:durable", [])
    assert await store.get_list(OWNER, "facts:durable") == []
    await store.set_list(OWNER, "facts:durable", [fact("a")])
    assert await store.get_list(OWNER, "facts:durable") == [fact("a")]
    await store.delete(OWNER, "facts:durable")
    assert await store.get_list(OWNER, "facts:durable") is None


async def test_list_order_preserved_and_replaced_whole(store):
    items = [fact(t) for t in "cab"]
    await store.set_list(OWNER, "facts:durable", items)
    assert [f["text"] for f in await store.get_list(OWNER, "facts:durable")] == ["c", "a", "b"]
    await store.set_list(OWNER, "facts:durable", items[::-1])
    assert [f["text"] for f in await store.get_list(OWNER, "facts:durable")] == ["b", "a", "c"]


async def test_owner_and_key_isolation(store):
    await store.set_list(OWNER, "facts:durable", [fact("mine")])
    await store.set_list(OWNER, "facts:s1", [fact("session")])
    await store.set_state(OWNER, "memory:off", {"off": True})
    assert await store.get_list(OTHER, "facts:durable") is None
    assert await store.get_state(OTHER, "memory:off") is None
    assert await store.keys(OTHER) == []
    assert await store.keys(OWNER) == ["facts:durable", "facts:s1", "memory:off"]
    await store.clear_owner(OWNER)
    assert await store.keys(OWNER) == []


async def test_state_roundtrip_and_delete(store):
    assert await store.get_state(OWNER, "memory:off") is None
    await store.set_state(OWNER, "memory:off", {"off": True})
    await store.set_state(OWNER, "memory:off", {"off": False})
    assert await store.get_state(OWNER, "memory:off") == {"off": False}
    await store.delete(OWNER, "memory:off")
    assert await store.get_state(OWNER, "memory:off") is None


async def test_audit_list_roundtrip_rotation_and_empty(store):
    assert await store.get_list(OWNER, "memory:audit") is None
    await store.set_list(OWNER, "memory:audit", [entry(1), entry(2), entry(3)])
    await store.set_list(OWNER, "memory:audit", [entry(2), entry(3), entry(4, "remove")])
    assert [e["seq"] for e in await store.get_list(OWNER, "memory:audit")] == [2, 3, 4]
    await store.set_list(OWNER, "memory:audit", [])
    assert await store.get_list(OWNER, "memory:audit") == []
    assert OTHER not in {OWNER} and await store.get_list(OTHER, "memory:audit") is None


async def test_wrong_kind_of_key_rejected(store):
    with pytest.raises(ValueError):
        await store.get_list(OWNER, "memory:off")
    with pytest.raises(ValueError):
        await store.set_state(OWNER, "facts:durable", {})


async def test_transaction_rolls_back_every_write_on_failure(store):
    await store.set_list(OWNER, "facts:durable", [fact("keep")])
    with pytest.raises(RuntimeError):
        async with store.transaction(OWNER):
            await store.set_list(OWNER, "facts:durable", [fact("keep"), fact("new")])
            await store.set_list(OWNER, "memory:audit", [entry(1)])
            await store.set_state(OWNER, "memory:off", {"off": True})
            raise RuntimeError("boom")
    assert [f["text"] for f in await store.get_list(OWNER, "facts:durable")] == ["keep"]
    assert await store.get_list(OWNER, "memory:audit") is None
    assert await store.get_state(OWNER, "memory:off") is None


async def test_transaction_commits_and_is_reentrant(store):
    async with store.transaction(OWNER):
        await store.set_list(OWNER, "facts:durable", [fact("a")])
        async with store.transaction(OWNER):
            await store.set_state(OWNER, "memory:off", {"off": True})
        assert await store.get_list(OWNER, "facts:durable") == [fact("a")]
    assert await store.get_state(OWNER, "memory:off") == {"off": True}


async def test_transactions_serialise_read_modify_write(store):
    """The keyed-update race: 20 concurrent read-modify-write appends all survive."""
    await store.set_list(OWNER, "facts:durable", [])

    async def append(i: int):
        async with store.transaction(OWNER):
            cur = await store.get_list(OWNER, "facts:durable") or []
            await asyncio.sleep(0)
            await store.set_list(OWNER, "facts:durable", [*cur, fact(f"f{i}")])

    await asyncio.gather(*(append(i) for i in range(20)))
    texts = [f["text"] for f in await store.get_list(OWNER, "facts:durable")]
    assert sorted(texts) == sorted(f"f{i}" for i in range(20))


async def test_values_are_copied_not_aliased(store):
    src = [fact("a")]
    await store.set_list(OWNER, "facts:durable", src)
    src[0]["text"] = "mutated"
    got = await store.get_list(OWNER, "facts:durable")
    got[0]["text"] = "also mutated"
    assert (await store.get_list(OWNER, "facts:durable"))[0]["text"] == "a"


async def test_audit_rejects_bad_seq(store):
    if isinstance(store, InMemoryMemoryStore):
        pytest.skip("SQL-only validation")
    with pytest.raises(ValueError):
        await store.set_list(OWNER, "memory:audit", [{"op": "add"}])
    with pytest.raises(ValueError):
        await store.set_list(OWNER, "memory:audit", [entry(1), entry(1)])


async def test_sql_restart_persistence(tmp_path):
    url = f"sqlite+aiosqlite:///{tmp_path / 'm.db'}"
    e1 = create_async_engine(url)
    s1 = SqlMemoryStore(e1)
    await s1.create_all()
    await s1.set_list(OWNER, "facts:durable", [fact("persist me", extra="é")])
    await s1.set_list(OWNER, "memory:audit", [entry(1)])
    await s1.set_state(OWNER, "memory:off", {"off": True})
    await e1.dispose()
    e2 = create_async_engine(url)
    s2 = SqlMemoryStore(e2)
    assert await s2.get_list(OWNER, "facts:durable") == [fact("persist me", extra="é")]
    assert [e["seq"] for e in await s2.get_list(OWNER, "memory:audit")] == [1]
    assert await s2.get_state(OWNER, "memory:off") == {"off": True}
    await e2.dispose()
