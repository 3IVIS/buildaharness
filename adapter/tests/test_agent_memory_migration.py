"""Migration 0013 up/down on SQLite, and agreement with store_sql's table definitions."""

import importlib.util
import pathlib

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

from harness.agent_memory import store_sql

_PATH = pathlib.Path(__file__).resolve().parent.parent / "migrations" / "versions" / "0013_agent_memory.py"
TABLES = {"agent_memory_facts", "agent_memory_audit", "agent_memory_state"}


def _load():
    spec = importlib.util.spec_from_file_location("mig_0013", _PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _run(conn, fn):
    ctx = MigrationContext.configure(conn)
    with Operations.context(ctx):
        fn()


def test_revision_chain():
    mod = _load()
    assert (mod.revision, mod.down_revision) == ("0013", "0012")


def test_upgrade_downgrade_roundtrip(tmp_path):
    mod = _load()
    engine = sa.create_engine(f"sqlite:///{tmp_path / 'mig.db'}")
    with engine.begin() as conn:
        _run(conn, mod.upgrade)
    insp = sa.inspect(engine)
    assert TABLES <= set(insp.get_table_names())
    with engine.begin() as conn:
        _run(conn, mod.downgrade)
    assert not (TABLES & set(sa.inspect(engine).get_table_names()))
    with engine.begin() as conn:  # up again: downgrade left nothing behind
        _run(conn, mod.upgrade)
    assert TABLES <= set(sa.inspect(engine).get_table_names())


def test_migration_matches_store_sql_definitions(tmp_path):
    mod = _load()
    engine = sa.create_engine(f"sqlite:///{tmp_path / 'mig.db'}")
    with engine.begin() as conn:
        _run(conn, mod.upgrade)
    insp = sa.inspect(engine)
    for table in store_sql.metadata.sorted_tables:
        cols = {c["name"]: c for c in insp.get_columns(table.name)}
        assert set(cols) == {c.name for c in table.columns}, table.name
        for c in table.columns:
            assert cols[c.name]["nullable"] == (c.nullable and not c.primary_key), (table.name, c.name)
        pk = insp.get_pk_constraint(table.name)["constrained_columns"]
        assert set(pk) == {c.name for c in table.primary_key.columns}
    uq = insp.get_unique_constraints("agent_memory_facts")
    assert any(u["column_names"] == ["owner_id", "store", "position"] for u in uq)
    idx = insp.get_indexes("agent_memory_facts")
    assert any(i["column_names"] == ["owner_id", "store"] for i in idx)


def test_store_works_on_migrated_schema(tmp_path):
    """The store runs against tables created by the migration, not only by create_all."""
    import asyncio

    from sqlalchemy.ext.asyncio import create_async_engine

    mod = _load()
    path = tmp_path / "mig.db"
    sync_engine = sa.create_engine(f"sqlite:///{path}")
    with sync_engine.begin() as conn:
        _run(conn, mod.upgrade)

    async def go():
        eng = create_async_engine(f"sqlite+aiosqlite:///{path}")
        s = store_sql.SqlMemoryStore(eng)
        await s.set_list("o", "facts:durable", [{"text": "a", "extractedAt": "t"}])
        await s.set_list("o", "memory:audit", [{"seq": 1, "at": "2026-01-01T00:00:00.000Z", "op": "add"}])
        await s.set_state("o", "memory:off", {"off": True})
        out = (await s.get_list("o", "facts:durable"), await s.get_state("o", "memory:off"))
        await eng.dispose()
        return out

    assert asyncio.run(go()) == ([{"text": "a", "extractedAt": "t"}], {"off": True})
