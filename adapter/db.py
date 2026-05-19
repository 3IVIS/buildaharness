"""
Database models and async engine — SQLAlchemy 2 + asyncpg.
Tables: users, flows, flow_versions
"""
import asyncio
import enum
import json as _json
import os
import sys
import uuid
from datetime import UTC, datetime

from sqlalchemy import (
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Text,
    UniqueConstraint,
    func,
    select,
)
from sqlalchemy.dialects.postgresql import JSONB as PG_JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, relationship
from sqlalchemy.types import Text as SAText
from sqlalchemy.types import TypeDecorator

# Fix: PostgreSQL dialect types (UUID, JSONB) crash on SQLite used in the test suite.
# Use TypeDecorator wrappers that fall back to TEXT on non-Postgres dialects.
# Production (Postgres) gets the real native UUID and JSONB types for indexability.

class _UUIDType(TypeDecorator):
    """UUID stored natively on Postgres, as TEXT elsewhere (tests/SQLite)."""
    impl = SAText
    cache_ok = True

    def load_dialect_impl(self, dialect):
        if dialect.name == "postgresql":
            return dialect.type_descriptor(PG_UUID(as_uuid=True))
        return dialect.type_descriptor(SAText())

    def process_bind_param(self, value, dialect):
        if value is None:
            return value
        if dialect.name == "postgresql":
            return value  # pass UUID object through
        return str(value)

    def process_result_value(self, value, dialect):
        if value is None:
            return value
        if isinstance(value, uuid.UUID):
            return value
        return uuid.UUID(str(value))


class _JSONBType(TypeDecorator):
    """JSONB on Postgres, JSON-encoded TEXT elsewhere (tests/SQLite)."""
    impl = SAText
    cache_ok = True

    def load_dialect_impl(self, dialect):
        if dialect.name == "postgresql":
            return dialect.type_descriptor(PG_JSONB())
        return dialect.type_descriptor(SAText())

    def process_bind_param(self, value, dialect):
        if value is None:
            return value
        if dialect.name == "postgresql":
            return value  # SQLAlchemy handles JSONB serialization natively
        return _json.dumps(value)

    def process_result_value(self, value, dialect):
        if value is None:
            return value
        if isinstance(value, (dict, list)):
            # asyncpg + SQLAlchemy already deserialized the JSONB to a Python object.
            return value
        # Fallback: value came back as a string (psycopg2 sync, or some edge cases
        # with asyncpg returning raw JSON strings). Parse it explicitly.
        try:
            return _json.loads(value)
        except (TypeError, ValueError):
            # Not parseable — return as-is and let the caller deal with it.
            return value

# Fix #12: fail at startup if DATABASE_URL is not configured rather than silently
# connecting to a hardcoded default that won't exist in production.
_db_url = os.getenv("DATABASE_URL")
if not _db_url:
    print(
        "FATAL: DATABASE_URL environment variable is not set.\n"
        "Example: postgresql+asyncpg://user:pass@host:5432/dbname",
        file=sys.stderr,
    )
    sys.exit(1)
DATABASE_URL = _db_url

engine       = create_async_engine(DATABASE_URL, echo=False)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id            = Column(_UUIDType, primary_key=True, default=uuid.uuid4)
    email         = Column(Text, unique=True, nullable=False)
    password_hash = Column(Text, nullable=False)
    created_at    = Column(DateTime(timezone=True), default=lambda: datetime.now(UTC))

    flows    = relationship("Flow",        back_populates="user", cascade="all, delete-orphan")
    versions = relationship("FlowVersion", back_populates="user")


class Flow(Base):
    __tablename__ = "flows"
    # Fix #19: explicit index on user_id — list_flows does WHERE user_id = ?
    __table_args__ = (Index("ix_flows_user_id", "user_id"),)

    id           = Column(Text, primary_key=True)   # matches FlowSpec.id
    user_id      = Column(_UUIDType, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    name         = Column(Text, nullable=False)
    current_spec = Column(_JSONBType, nullable=False)
    created_at   = Column(DateTime(timezone=True), default=lambda: datetime.now(UTC))
    # Fix #18: onupdate ensures the column is always refreshed on UPDATE statements,
    # not just on INSERT. save_flow still sets it explicitly for clarity, but any
    # future code path that modifies a Flow row will also get the correct timestamp.
    updated_at   = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
    )

    user     = relationship("User",        back_populates="flows")
    versions = relationship("FlowVersion", back_populates="flow",
                            cascade="all, delete-orphan",
                            order_by="FlowVersion.version_num")


class FlowVersion(Base):
    __tablename__  = "flow_versions"
    __table_args__ = (UniqueConstraint("flow_id", "version_num"),)

    id          = Column(_UUIDType, primary_key=True, default=uuid.uuid4)
    flow_id     = Column(Text, ForeignKey("flows.id", ondelete="CASCADE"), nullable=False)
    user_id     = Column(_UUIDType, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    spec        = Column(_JSONBType, nullable=False)
    version_num = Column(Integer, nullable=False)
    label       = Column(Text, nullable=True)
    created_at  = Column(DateTime(timezone=True), default=lambda: datetime.now(UTC))

    flow = relationship("Flow", back_populates="versions")
    user = relationship("User", back_populates="versions")


async def get_session():
    async with SessionLocal() as session:
        yield session


# ── Team RBAC models ──────────────────────────────────────────────────────────

class TeamRole(enum.StrEnum):
    admin  = "admin"
    editor = "editor"
    viewer = "viewer"


class Team(Base):
    """An organisation-level grouping that can own flows and share them with members."""
    __tablename__ = "teams"

    id         = Column(_UUIDType, primary_key=True, default=uuid.uuid4)
    name       = Column(Text, nullable=False)
    created_by = Column(_UUIDType, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(UTC))

    memberships = relationship("TeamMembership", back_populates="team",
                               cascade="all, delete-orphan")
    flow_permissions = relationship("FlowPermission", back_populates="team",
                                    cascade="all, delete-orphan")


class TeamMembership(Base):
    """User ↔ Team with a role."""
    __tablename__  = "team_memberships"
    __table_args__ = (
        UniqueConstraint("team_id", "user_id", name="uq_team_memberships_team_user"),
        Index("ix_team_memberships_user_id", "user_id"),
    )

    id        = Column(_UUIDType, primary_key=True, default=uuid.uuid4)
    team_id   = Column(_UUIDType, ForeignKey("teams.id", ondelete="CASCADE"), nullable=False)
    user_id   = Column(_UUIDType, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    # role: admin can manage members; editor can save flows; viewer is read-only.
    role      = Column(Text, nullable=False, default=TeamRole.viewer.value)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(UTC))

    team = relationship("Team", back_populates="memberships")
    user = relationship("User")


class FlowPermission(Base):
    """Grants a team access to a flow (read-only or read-write).

    Absence of a row means the flow is private to its owner.
    A row with permission='view' lets team members open and compile the flow.
    A row with permission='edit' lets Editor+ members save new versions.
    """
    __tablename__  = "flow_permissions"
    __table_args__ = (
        UniqueConstraint("flow_id", "team_id", name="uq_flow_permissions_flow_team"),
        Index("ix_flow_permissions_flow_id", "flow_id"),
        Index("ix_flow_permissions_team_id", "team_id"),
    )

    id         = Column(_UUIDType, primary_key=True, default=uuid.uuid4)
    flow_id    = Column(Text, ForeignKey("flows.id", ondelete="CASCADE"), nullable=False)
    team_id    = Column(_UUIDType, ForeignKey("teams.id", ondelete="CASCADE"), nullable=False)
    # permission: 'view' (read-only) or 'edit' (read-write for editors)
    permission = Column(Text, nullable=False, default="view")
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(UTC))

    flow = relationship("Flow")
    team = relationship("Team", back_populates="flow_permissions")


class A2ADeployment(Base):
    """Persists a deployed A2A agent endpoint.

    One row per flow (unique constraint on flow_id).  Re-deploying upserts
    the row so external agents always discover a stable endpoint URL.
    """
    __tablename__ = "a2a_deployments"
    __table_args__ = (
        Index("ix_a2a_deployments_user_id", "user_id"),
    )

    id           = Column(_UUIDType, primary_key=True, default=uuid.uuid4)
    flow_id      = Column(Text, ForeignKey("flows.id", ondelete="CASCADE"),
                          nullable=False, unique=True)
    user_id      = Column(_UUIDType, ForeignKey("users.id", ondelete="CASCADE"),
                          nullable=False)
    endpoint_url = Column(Text, nullable=False)
    # Snapshot of the AgentCard JSONB at deploy time — external agents get a
    # stable card even if the flow spec changes after deployment.
    agent_card   = Column(_JSONBType, nullable=False)
    deployed_at  = Column(DateTime(timezone=True), default=lambda: datetime.now(UTC))

    flow = relationship("Flow")
    user = relationship("User")


async def next_version_num(flow_id: str, db: AsyncSession) -> int:
    # Fix #17: use with_for_update() on Postgres to lock the flow row for the
    # duration of the transaction, preventing a TOCTOU race when two requests
    # save the same flow concurrently and both read the same max(version_num)
    # before either inserts.
    #
    # SQLite (used in the test suite) does not support SELECT ... FOR UPDATE
    # and raises OperationalError. Catch it and fall through gracefully —
    # SQLite's file-level write lock provides sufficient serialisation for tests.
    try:
        await db.execute(
            select(Flow).where(Flow.id == flow_id).with_for_update()
        )
    except Exception:  # noqa: S110
        # SQLite / other dialects that don't support FOR UPDATE — safe to ignore
        # because the surrounding transaction still serialises writes.
        pass
    result = await db.execute(
        select(func.max(FlowVersion.version_num)).where(FlowVersion.flow_id == flow_id)
    )
    current_max = result.scalar_one_or_none()
    return (current_max or 0) + 1


async def init_db():
    """Initialise the database schema.

    Test suite (TESTING=true):
        SQLite in-memory — Alembic cannot run migrations against SQLite because
        the initial migration uses PostgreSQL-specific types (UUID, JSONB).
        create_all() is fast and sufficient for isolated test runs.

    Production (Postgres):
        Alembic runs `upgrade head` so every schema change is version-controlled
        and repeatable. The Dockerfile CMD runs `alembic upgrade head` before
        starting uvicorn; this function is a defensive fallback for any code path
        that calls init_db() directly (e.g. local `python main.py`).
    """
    if os.getenv("TESTING") == "true":
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        print("[db] tables ready (test mode — create_all)")
        return

    # Production: run Alembic in a thread so we don't block the event loop.
    from pathlib import Path as _Path

    from alembic import command as _alembic_cmd
    from alembic.config import Config as _AlembicConfig

    def _run_alembic() -> None:
        cfg = _AlembicConfig(str(_Path(__file__).parent / "alembic.ini"))
        cfg.set_main_option("sqlalchemy.url", DATABASE_URL)
        _alembic_cmd.upgrade(cfg, "head")

    await asyncio.to_thread(_run_alembic)
    print("[db] Alembic migrations applied")

