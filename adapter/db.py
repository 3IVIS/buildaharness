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
    Boolean,
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
    # SSO / OIDC identity (NULL for local password accounts)
    sso_sub       = Column(Text, nullable=True)   # OIDC sub claim
    sso_provider  = Column(Text, nullable=True)   # e.g. "keycloak"
    is_active     = Column(Boolean, nullable=False, default=True)
    last_login_at = Column(DateTime(timezone=True), nullable=True)
    created_at    = Column(DateTime(timezone=True), default=lambda: datetime.now(UTC))

    flows    = relationship("Flow",        back_populates="user", cascade="all, delete-orphan")
    versions = relationship("FlowVersion", back_populates="user")


class Flow(Base):
    __tablename__ = "flows"
    # Fix #19: explicit index on user_id — list_flows does WHERE user_id = ?
    __table_args__ = (
        Index("ix_flows_user_id", "user_id"),
        Index("ix_flows_org_id",  "org_id"),
    )

    id           = Column(Text, primary_key=True)   # matches FlowSpec.id
    user_id      = Column(_UUIDType, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    org_id       = Column(_UUIDType, ForeignKey("orgs.id",  ondelete="SET NULL"), nullable=True)
    name         = Column(Text, nullable=False)
    current_spec = Column(_JSONBType, nullable=False)
    created_at   = Column(DateTime(timezone=True), default=lambda: datetime.now(UTC))
    updated_at   = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
    )

    user     = relationship("User",        back_populates="flows")
    org      = relationship("Org")
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
    org_id     = Column(_UUIDType, ForeignKey("orgs.id",  ondelete="SET NULL"), nullable=True)
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


class OrgRole(enum.StrEnum):
    admin  = "admin"
    member = "member"


class Org(Base):
    """An organisation — the top-level isolation boundary.

    Every user gets a personal org on registration (name = email prefix).
    Teams can optionally be promoted to org-level by setting their org_id.

    Per-org Langfuse keys allow each tenant to have its own Langfuse project
    so traces, evals, and prompts are completely isolated.  NULL keys mean
    "use the global LANGFUSE_* env vars" (shared project — acceptable for
    single-tenant installs or dev).
    """
    __tablename__ = "orgs"
    __table_args__ = (
        Index("ix_orgs_owner_id", "owner_id"),
    )

    id                  = Column(_UUIDType, primary_key=True, default=uuid.uuid4)
    name                = Column(Text, nullable=False)
    owner_id            = Column(_UUIDType, ForeignKey("users.id", ondelete="SET NULL"),
                                 nullable=True)
    is_personal         = Column(Text, nullable=False, default="false")  # "true"|"false"
    # Per-org Langfuse project keys. NULL → fall back to global env-var keys.
    langfuse_public_key = Column(Text, nullable=True)
    langfuse_secret_key = Column(Text, nullable=True)
    created_at          = Column(DateTime(timezone=True), default=lambda: datetime.now(UTC))

    owner       = relationship("User", foreign_keys=[owner_id])
    memberships = relationship("OrgMembership", back_populates="org",
                               cascade="all, delete-orphan")


class OrgMembership(Base):
    """User ↔ Org with a role (admin | member)."""
    __tablename__  = "org_memberships"
    __table_args__ = (
        UniqueConstraint("org_id", "user_id", name="uq_org_memberships_org_user"),
        Index("ix_org_memberships_user_id", "user_id"),
        Index("ix_org_memberships_org_id",  "org_id"),
    )

    id         = Column(_UUIDType, primary_key=True, default=uuid.uuid4)
    org_id     = Column(_UUIDType, ForeignKey("orgs.id",  ondelete="CASCADE"), nullable=False)
    user_id    = Column(_UUIDType, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    role       = Column(Text, nullable=False, default=OrgRole.member.value)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(UTC))

    org  = relationship("Org",  back_populates="memberships")
    user = relationship("User")


class A2ADeployment(Base):
    """Persists a deployed A2A agent endpoint.

    One row per flow (unique constraint on flow_id).  Re-deploying upserts
    the row so external agents always discover a stable endpoint URL.
    """
    __tablename__ = "a2a_deployments"
    __table_args__ = (
        Index("ix_a2a_deployments_user_id", "user_id"),
        Index("ix_a2a_deployments_org_id",  "org_id"),
    )

    id           = Column(_UUIDType, primary_key=True, default=uuid.uuid4)
    flow_id      = Column(Text, ForeignKey("flows.id", ondelete="CASCADE"),
                          nullable=False, unique=True)
    user_id      = Column(_UUIDType, ForeignKey("users.id", ondelete="CASCADE"),
                          nullable=False)
    org_id       = Column(_UUIDType, ForeignKey("orgs.id", ondelete="SET NULL"),
                          nullable=True)
    endpoint_url = Column(Text, nullable=False)
    # Snapshot of the AgentCard JSONB at deploy time — external agents get a
    # stable card even if the flow spec changes after deployment.
    agent_card   = Column(_JSONBType, nullable=False)
    deployed_at  = Column(DateTime(timezone=True), default=lambda: datetime.now(UTC))

    flow = relationship("Flow")
    user = relationship("User")
    org  = relationship("Org")


class CommunityComponent(Base):
    """A community-published component in the marketplace.

    Each row is one installable component — typically a pre-configured
    tool_invoke node with an npm package ref, description, and ready-to-drop
    node_spec fragment.  Verified components are published under the
    @itsharness scope and seeded at startup.

    slug          — URL-safe unique key, e.g. 'web-search'
    name          — display name shown in the sidebar card
    description   — one-sentence description shown below the name
    category      — 'tool' | 'memory' | 'agent' | 'control'
    icon_emoji    — single emoji used as the card icon
    npm_ref       — full npm package ref, e.g. '@langchain/community/tools/TavilySearchResults'
    source        — 'npm' | 'mcp' | 'local'
    node_spec     — ready-to-use FlowSpec node fragment (dropped onto canvas on install)
    tool_def      — ToolDef dict auto-registered in the flow's tools registry on install
    tags          — list[str] for full-text search
    verified      — 'true' for @itsharness/* packages (shown with ✓ badge)
    author        — package author handle
    install_count — incremented on each POST /marketplace/{slug}/install
    """
    __tablename__ = "community_components"
    __table_args__ = (
        Index("ix_community_components_category", "category"),
        Index("ix_community_components_verified", "verified"),
    )

    id            = Column(_UUIDType, primary_key=True, default=uuid.uuid4)
    slug          = Column(Text, nullable=False, unique=True)
    name          = Column(Text, nullable=False)
    description   = Column(Text, nullable=False)
    category      = Column(Text, nullable=False)
    icon_emoji    = Column(Text, nullable=False, default="🔧")
    npm_ref       = Column(Text, nullable=False)
    source        = Column(Text, nullable=False, default="npm")
    node_spec     = Column(_JSONBType, nullable=False, default=dict)
    tool_def      = Column(_JSONBType, nullable=True)
    tags          = Column(_JSONBType, nullable=False, default=list)
    verified      = Column(Text, nullable=False, default="false")
    author        = Column(Text, nullable=False, default="@itsharness")
    install_count = Column(Integer, nullable=False, default=0)
    created_at    = Column(DateTime(timezone=True), default=lambda: datetime.now(UTC))
    updated_at    = Column(DateTime(timezone=True), default=lambda: datetime.now(UTC),
                           onupdate=lambda: datetime.now(UTC))


class UnifiedDeployment(Base):
    """One-click deployment record: REST endpoint + MCP tool + A2A agent.

    A single row per flow (unique on flow_id).  Created or updated by
    POST /deploy/{flow_id}.  Stores URL snapshots and the MCP tool manifest
    at deploy time so discovery endpoints return stable data even if the flow
    spec is later edited.

    rest_url      — POST to execute the flow synchronously
    mcp_url       — GET the MCP tool manifest (public discovery)
    a2a_url       — POST to start an A2A task (null when A2A not enabled)
    shareable_url — human-readable share link (GET returns deployment metadata)
    mcp_manifest  — full MCP tools list snapshot; served by /.well-known/mcp/
    """
    __tablename__ = "unified_deployments"
    __table_args__ = (
        Index("ix_unified_deployments_user_id", "user_id"),
        Index("ix_unified_deployments_org_id",  "org_id"),
    )

    id            = Column(_UUIDType, primary_key=True, default=uuid.uuid4)
    flow_id       = Column(Text, ForeignKey("flows.id", ondelete="CASCADE"),
                           nullable=False, unique=True)
    user_id       = Column(_UUIDType, ForeignKey("users.id", ondelete="CASCADE"),
                           nullable=False)
    org_id        = Column(_UUIDType, ForeignKey("orgs.id", ondelete="SET NULL"),
                           nullable=True)
    rest_url      = Column(Text, nullable=False)
    mcp_url       = Column(Text, nullable=False)
    a2a_url       = Column(Text, nullable=True)
    shareable_url = Column(Text, nullable=False)
    mcp_manifest  = Column(_JSONBType, nullable=False, default=dict)
    deployed_at   = Column(DateTime(timezone=True), default=lambda: datetime.now(UTC))

    flow = relationship("Flow")
    user = relationship("User")
    org  = relationship("Org")


class Job(Base):
    """Persisted run-job state — replaces the in-memory _jobs dict.

    One row per job / A2A task.  Background runners read and write this row
    instead of the process-local dict, so jobs survive restarts and multiple
    workers can all serve status reads.

    id         TEXT PK     — UUID string for /run jobs; arbitrary string for A2A
                             tasks (caller-supplied, not guaranteed to be a UUID).
    user_id    UUID FK      — ownership guard; GET /run/{id} returns 404 for wrong user.
    status     TEXT         — queued | running | paused | done | error
    runtime    TEXT         — langgraph | crewai
    result     TEXT         — JSON output string on success (can be large)
    error      TEXT         — exception message on failure
    node_events JSONB       — list of {node_id, status, ts, ms?, tokens?}
    hitl_state  JSONB       — {node_id, prompt, resume_schema_fields} when paused
    trace_id   TEXT         — Langfuse trace ID (populated during run)
    trace_url  TEXT         — Langfuse trace URL
    started_at TIMESTAMPTZ  — updated to actual start time when runner begins
    ended_at   TIMESTAMPTZ  — set when job reaches done / error
    created_at TIMESTAMPTZ  — insert timestamp; used for TTL eviction index

    The compiled_graph, lg_config, and trackable fields from the old in-memory
    dict are NOT persisted — they hold live Python objects (compiled LangGraph
    graphs) that cannot be serialised.  The resume path re-compiles the graph
    from the spec stored in the flows table, which is equivalent and correct.
    """
    __tablename__ = "jobs"
    __table_args__ = (
        Index("ix_jobs_user_id",         "user_id"),
        Index("ix_jobs_status_ended_at", "status", "ended_at"),
        Index("ix_jobs_org_id",          "org_id"),
    )

    id          = Column(Text, primary_key=True)
    user_id     = Column(_UUIDType, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    org_id      = Column(_UUIDType, ForeignKey("orgs.id",  ondelete="SET NULL"), nullable=True)
    status      = Column(Text, nullable=False, default="queued")
    runtime     = Column(Text, nullable=False)
    result      = Column(Text, nullable=True)
    error       = Column(Text, nullable=True)
    node_events = Column(_JSONBType, nullable=False, default=list)
    hitl_state  = Column(_JSONBType, nullable=True)
    trace_id    = Column(Text, nullable=True)
    trace_url   = Column(Text, nullable=True)
    started_at  = Column(DateTime(timezone=True), default=lambda: datetime.now(UTC))
    ended_at    = Column(DateTime(timezone=True), nullable=True)
    created_at  = Column(DateTime(timezone=True), default=lambda: datetime.now(UTC))
    # A2A-specific metadata (null for plain /run jobs)
    a2a_flow_id = Column(Text, nullable=True)
    a2a_message = Column(Text, nullable=True)  # JSON-encoded A2AMessage

    user = relationship("User")
    org  = relationship("Org")


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

