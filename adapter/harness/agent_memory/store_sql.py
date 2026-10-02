"""SQL-backed MemoryStore (SQLAlchemy Core, async) for agent memory.

Mirrors the key-value shape of the TS storage adapter:

* ``facts:*`` keys (durable, pending, rejected, retired, per-session) are lists held in
  ``agent_memory_facts``, one row per fact, ordered by ``position``.
* the audit key is a list held in ``agent_memory_audit`` (primary key ``(owner_id, seq)``).
* every other key (the off switch, the consolidation state ...) is a state value held in
  ``agent_memory_state``.

"Absent" and "empty" stay distinguishable for lists through a sentinel row (position -1 for
facts, seq 0 for the audit log).  Every operation is owner scoped.

``transaction(owner)`` serialises writers for one owner and makes every read/write inside the
block share one DB transaction: commit on clean exit, rollback on any exception, so a failure
leaves no partial write.  SQLite has one writer, so there a single process-wide lock is used;
on Postgres the owner's state row is locked with ``SELECT ... FOR UPDATE``.  The tables are
defined here with Core (no import of ``db.py``) so ``harness/`` stays self-contained; the
migration ``0013_agent_memory.py`` is the production DDL and a test pins the two together.
"""

from __future__ import annotations

import asyncio
import contextvars
import json
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine
from sqlalchemy.types import TypeDecorator

from ._core_generated import STORE_KEYS

AUDIT_KEY = STORE_KEYS["audit"]
FACTS_PREFIX = "facts:"
# Sentinels: a stored-but-empty list is one marker row.
EMPTY_FACT_POSITION = -1
EMPTY_AUDIT_SEQ = 0
# State-table key of the row locked (Postgres) to serialise one owner's writers.
_LOCK_STATE_KEY = "__lock__"


class _Json(TypeDecorator):
    """JSONB on Postgres, JSON-encoded TEXT elsewhere (tests/SQLite)."""

    impl = sa.Text
    cache_ok = True

    def load_dialect_impl(self, dialect):
        if dialect.name == "postgresql":
            return dialect.type_descriptor(JSONB())
        return dialect.type_descriptor(sa.Text())

    def process_bind_param(self, value, dialect):
        if value is None or dialect.name == "postgresql":
            return value
        return json.dumps(value, ensure_ascii=False)

    def process_result_value(self, value, dialect):
        if value is None or isinstance(value, (dict, list)):
            return value
        try:
            return json.loads(value)
        except (TypeError, ValueError):
            return value


metadata = sa.MetaData()

facts_table = sa.Table(
    "agent_memory_facts",
    metadata,
    sa.Column("id", sa.String(36), primary_key=True),
    sa.Column("owner_id", sa.String, nullable=False),
    sa.Column("store", sa.String, nullable=False),
    sa.Column("position", sa.Integer, nullable=False),
    sa.Column("fact_id", sa.String, nullable=False, server_default=""),
    sa.Column("payload", _Json, nullable=False),
    sa.Column("created_at", sa.TIMESTAMP, nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
    sa.UniqueConstraint("owner_id", "store", "position", name="uq_agent_memory_facts_owner_store_pos"),
    sa.Index("ix_agent_memory_facts_owner_store", "owner_id", "store"),
)

audit_table = sa.Table(
    "agent_memory_audit",
    metadata,
    sa.Column("owner_id", sa.String, nullable=False),
    sa.Column("seq", sa.Integer, nullable=False),
    sa.Column("at", sa.TIMESTAMP, nullable=True),
    sa.Column("op", sa.String, nullable=False, server_default=""),
    sa.Column("store", sa.String, nullable=False, server_default=""),
    sa.Column("fact_id", sa.String, nullable=False, server_default=""),
    sa.Column("payload", _Json, nullable=False),
    sa.PrimaryKeyConstraint("owner_id", "seq", name="pk_agent_memory_audit"),
)

state_table = sa.Table(
    "agent_memory_state",
    metadata,
    sa.Column("owner_id", sa.String, nullable=False),
    sa.Column("key", sa.String, nullable=False),
    sa.Column("value", _Json, nullable=False),
    sa.PrimaryKeyConstraint("owner_id", "key", name="pk_agent_memory_state"),
)


def _parse_at(value: Any) -> datetime | None:
    """Best-effort ISO-8601 -> naive UTC.  The wire string stays authoritative in ``payload``."""
    if not isinstance(value, str):
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(UTC).replace(tzinfo=None)
    return dt


def _is_list_key(key: str) -> bool:
    return key == AUDIT_KEY or key.startswith(FACTS_PREFIX)


class SqlMemoryStore:
    """MemoryStore over an ``AsyncEngine`` (SQLite via aiosqlite in tests, Postgres via asyncpg)."""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine
        self._is_postgres = engine.dialect.name == "postgresql"
        # SQLite (and its single shared in-memory connection) allows one writer at a time.
        self._sqlite_lock = asyncio.Lock()
        self._conn: contextvars.ContextVar[AsyncConnection | None] = contextvars.ContextVar(
            f"agent_memory_conn_{id(self)}", default=None
        )

    async def create_all(self) -> None:
        """Create the three tables (tests and local dev; production uses alembic 0013)."""
        async with self._engine.begin() as conn:
            await conn.run_sync(metadata.create_all)

    # ------------------------------------------------------------------ plumbing

    @asynccontextmanager
    async def _use_conn(self) -> AsyncIterator[AsyncConnection]:
        """Reuse the open transaction's connection, or run this one operation in its own."""
        current = self._conn.get()
        if current is not None:
            yield current
            return
        if self._is_postgres:
            async with self._engine.begin() as conn:
                yield conn
            return
        async with self._sqlite_lock, self._engine.begin() as conn:
            yield conn

    @asynccontextmanager
    async def transaction(self, owner: str) -> AsyncIterator[None]:
        """Serialise writers for ``owner``; all store calls inside share one DB transaction."""
        if self._conn.get() is not None:  # re-entrant: join the open transaction
            yield
            return
        if self._is_postgres:
            async with self._engine.begin() as conn:
                await self._pg_lock_owner(conn, owner)
                token = self._conn.set(conn)
                try:
                    yield
                finally:
                    self._conn.reset(token)
            return
        async with self._sqlite_lock, self._engine.begin() as conn:
            token = self._conn.set(conn)
            try:
                yield
            finally:
                self._conn.reset(token)

    @staticmethod
    async def _pg_lock_owner(conn: AsyncConnection, owner: str) -> None:
        # Create the owner's lock row on first use (no-op when present), then lock it.
        await conn.execute(
            sa.text(
                "INSERT INTO agent_memory_state (owner_id, key, value) "
                "VALUES (:o, :k, CAST('{}' AS jsonb)) ON CONFLICT DO NOTHING"
            ),
            {"o": owner, "k": _LOCK_STATE_KEY},
        )
        await conn.execute(
            sa.select(state_table.c.owner_id)
            .where(state_table.c.owner_id == owner, state_table.c.key == _LOCK_STATE_KEY)
            .with_for_update()
        )

    # ------------------------------------------------------------------ lists

    async def get_list(self, owner: str, key: str) -> list[dict[str, Any]] | None:
        if not _is_list_key(key):
            raise ValueError(f"not a list key: {key!r}")
        async with self._use_conn() as conn:
            if key == AUDIT_KEY:
                rows = (
                    await conn.execute(
                        sa.select(audit_table.c.seq, audit_table.c.payload)
                        .where(audit_table.c.owner_id == owner)
                        .order_by(audit_table.c.seq)
                    )
                ).all()
                if not rows:
                    return None
                return [r.payload for r in rows if r.seq != EMPTY_AUDIT_SEQ]
            rows = (
                await conn.execute(
                    sa.select(facts_table.c.position, facts_table.c.payload)
                    .where(facts_table.c.owner_id == owner, facts_table.c.store == key)
                    .order_by(facts_table.c.position)
                )
            ).all()
            if not rows:
                return None
            return [r.payload for r in rows if r.position != EMPTY_FACT_POSITION]

    async def set_list(self, owner: str, key: str, items: list[dict[str, Any]]) -> None:
        if not _is_list_key(key):
            raise ValueError(f"not a list key: {key!r}")
        async with self._use_conn() as conn:
            if key == AUDIT_KEY:
                await self._set_audit(conn, owner, items)
            else:
                await self._set_facts(conn, owner, key, items)

    @staticmethod
    async def _set_facts(conn: AsyncConnection, owner: str, key: str, items: list[dict[str, Any]]) -> None:
        await conn.execute(sa.delete(facts_table).where(facts_table.c.owner_id == owner, facts_table.c.store == key))
        if not items:
            rows = [(EMPTY_FACT_POSITION, "", {"empty": True})]
        else:
            rows = [(i, f"{it.get('text', '')}|{it.get('extractedAt', '')}", it) for i, it in enumerate(items)]
        await conn.execute(
            sa.insert(facts_table),
            [
                {
                    "id": str(uuid.uuid4()),
                    "owner_id": owner,
                    "store": key,
                    "position": pos,
                    "fact_id": fid,
                    "payload": payload,
                }
                for pos, fid, payload in rows
            ],
        )

    @staticmethod
    async def _set_audit(conn: AsyncConnection, owner: str, items: list[dict[str, Any]]) -> None:
        seqs: list[int] = []
        for it in items:
            seq = it.get("seq")
            if not isinstance(seq, int) or isinstance(seq, bool) or seq <= EMPTY_AUDIT_SEQ:
                raise ValueError("audit entries need a positive integer seq")
            seqs.append(seq)
        if len(set(seqs)) != len(seqs):
            raise ValueError("duplicate audit seq")
        existing = {
            r.seq: r.payload
            for r in (
                await conn.execute(
                    sa.select(audit_table.c.seq, audit_table.c.payload).where(audit_table.c.owner_id == owner)
                )
            ).all()
        }
        wanted = set(seqs) if items else {EMPTY_AUDIT_SEQ}
        drop = [s for s in existing if s not in wanted]
        if drop:
            await conn.execute(
                sa.delete(audit_table).where(audit_table.c.owner_id == owner, audit_table.c.seq.in_(drop))
            )
        if not items:
            if EMPTY_AUDIT_SEQ not in existing:
                await conn.execute(
                    sa.insert(audit_table),
                    [{"owner_id": owner, "seq": EMPTY_AUDIT_SEQ, "payload": {"empty": True}}],
                )
            return
        for it in items:
            seq = it["seq"]
            vals = {
                "at": _parse_at(it.get("at")),
                "op": str(it.get("op", "")),
                "store": str(it.get("store", "")),
                "fact_id": str(it.get("factId", "")),
                "payload": it,
            }
            if seq not in existing:
                await conn.execute(sa.insert(audit_table), [{"owner_id": owner, "seq": seq, **vals}])
            elif existing[seq] != it:
                await conn.execute(
                    sa.update(audit_table)
                    .where(audit_table.c.owner_id == owner, audit_table.c.seq == seq)
                    .values(**vals)
                )

    # ------------------------------------------------------------------ state

    async def get_state(self, owner: str, key: str) -> dict[str, Any] | None:
        if _is_list_key(key) or key == _LOCK_STATE_KEY:
            raise ValueError(f"not a state key: {key!r}")
        async with self._use_conn() as conn:
            row = (
                await conn.execute(
                    sa.select(state_table.c.value).where(state_table.c.owner_id == owner, state_table.c.key == key)
                )
            ).first()
            return None if row is None else row.value

    async def set_state(self, owner: str, key: str, value: dict[str, Any]) -> None:
        if _is_list_key(key) or key == _LOCK_STATE_KEY:
            raise ValueError(f"not a state key: {key!r}")
        async with self._use_conn() as conn:
            await conn.execute(sa.delete(state_table).where(state_table.c.owner_id == owner, state_table.c.key == key))
            await conn.execute(sa.insert(state_table), [{"owner_id": owner, "key": key, "value": value}])

    # ------------------------------------------------------------------ generic

    async def delete(self, owner: str, key: str) -> None:
        """Remove a key entirely (list or state), leaving it absent."""
        async with self._use_conn() as conn:
            if key == AUDIT_KEY:
                await conn.execute(sa.delete(audit_table).where(audit_table.c.owner_id == owner))
            elif key.startswith(FACTS_PREFIX):
                await conn.execute(
                    sa.delete(facts_table).where(facts_table.c.owner_id == owner, facts_table.c.store == key)
                )
            else:
                await conn.execute(
                    sa.delete(state_table).where(state_table.c.owner_id == owner, state_table.c.key == key)
                )

    async def keys(self, owner: str) -> list[str]:
        """Every key present for ``owner`` (sorted)."""
        async with self._use_conn() as conn:
            out = {
                r.store
                for r in (
                    await conn.execute(sa.select(facts_table.c.store).where(facts_table.c.owner_id == owner).distinct())
                ).all()
            }
            if (
                await conn.execute(sa.select(audit_table.c.seq).where(audit_table.c.owner_id == owner).limit(1))
            ).first():
                out.add(AUDIT_KEY)
            out.update(
                r.key
                for r in (await conn.execute(sa.select(state_table.c.key).where(state_table.c.owner_id == owner))).all()
                if r.key != _LOCK_STATE_KEY
            )
            return sorted(out)

    async def clear_owner(self, owner: str) -> None:
        """Delete everything stored for ``owner`` (erasure)."""
        async with self._use_conn() as conn:
            for t in (facts_table, audit_table, state_table):
                await conn.execute(sa.delete(t).where(t.c.owner_id == owner))
