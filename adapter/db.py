"""
Database models and async engine — SQLAlchemy 2 + asyncpg.
Tables: users, flows, flow_versions
"""
import os
import sys
import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Column, Text, Integer, DateTime, ForeignKey, Index,
    UniqueConstraint, func, select,
)
from sqlalchemy.types import TypeDecorator, String, Text as SAText
from sqlalchemy.dialects.postgresql import UUID as PG_UUID, JSONB as PG_JSONB
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase, relationship
import json as _json

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
    created_at    = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

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
    created_at   = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    # Fix #18: onupdate ensures the column is always refreshed on UPDATE statements,
    # not just on INSERT. save_flow still sets it explicitly for clarity, but any
    # future code path that modifies a Flow row will also get the correct timestamp.
    updated_at   = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
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
    created_at  = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    flow = relationship("Flow", back_populates="versions")
    user = relationship("User", back_populates="versions")


async def get_session():
    async with SessionLocal() as session:
        yield session


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
    except Exception:
        # SQLite / other dialects that don't support FOR UPDATE — safe to ignore
        # because the surrounding transaction still serialises writes.
        pass
    result = await db.execute(
        select(func.max(FlowVersion.version_num)).where(FlowVersion.flow_id == flow_id)
    )
    current_max = result.scalar_one_or_none()
    return (current_max or 0) + 1


async def init_db():
    # Fix #10: create_all() creates tables that don't exist but does NOT alter tables
    # that already exist.  Any schema change (new column, changed constraint) after
    # initial deployment requires a migration.
    #
    # For production deployments, use Alembic:
    #   pip install alembic
    #   alembic init adapter/migrations
    #   alembic revision --autogenerate -m "describe change"
    #   alembic upgrade head
    #
    # create_all() is kept here for fresh environments and the test suite (SQLite).
    # In a production cluster, replace this with: alembic upgrade head
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    print("[db] tables ready")
