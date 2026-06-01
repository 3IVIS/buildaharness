"""Postgres-backed job store — replaces in-memory _jobs dict

Revision ID: 0004
Revises: 0003
Create Date: 2026-05-19

Stores all run-job state in Postgres so that:
  - Jobs survive adapter restarts
  - WEB_CONCURRENCY > 1 workers can all serve job-status reads
  - TTL eviction is a DB DELETE instead of in-memory cleanup

The in-memory _jobs dict stored everything in one flat dict.  The new table
mirrors that structure 1-to-1 so run_api.py can be refactored with minimal
API-surface changes.

Columns:
  id          TEXT PK             — UUID string for /run jobs; arbitrary string
                                    for A2A tasks (caller-supplied task ID).
                                    TEXT (not UUID) so A2A task IDs that are not
                                    UUIDs are accepted without coercion.
  user_id     UUID FK → users.id  — ownership / auth guard
  status      TEXT NOT NULL       — queued | running | paused | done | error
  runtime     TEXT NOT NULL       — langgraph | crewai
  result      TEXT                — JSON string output on success
  error       TEXT                — exception message on failure
  node_events JSONB DEFAULT '[]'  — list of {node_id, status, ts, ms, tokens}
  hitl_state  JSONB               — {node_id, prompt, resume_schema_fields}
  trace_id    TEXT                — Langfuse trace ID
  trace_url   TEXT                — Langfuse trace URL
  started_at  TIMESTAMPTZ         — set to now() on insert (updated to actual
                                    start when the background runner begins)
  ended_at    TIMESTAMPTZ         — set when the job reaches done/error/paused
  created_at  TIMESTAMPTZ         — insert timestamp; used by TTL eviction index

Indexes:
  ix_jobs_user_id          — list/lookup by owner (fast auth guard)
  ix_jobs_status_ended_at  — TTL eviction query: status IN ('done','error')
                             AND ended_at < cutoff

Downgrade:
  Drops the table (safe — nothing else references jobs.id as an FK).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "jobs",
        # Primary key: TEXT so A2A caller-supplied IDs (not guaranteed UUID) work.
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("status", sa.Text(), nullable=False, server_default="queued"),
        sa.Column("runtime", sa.Text(), nullable=False),
        sa.Column("result", sa.Text(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column(
            "node_events",
            postgresql.JSONB(),
            nullable=False,
            server_default="[]",
        ),
        sa.Column("hitl_state", postgresql.JSONB(), nullable=True),
        sa.Column("trace_id", sa.Text(), nullable=True),
        sa.Column("trace_url", sa.Text(), nullable=True),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        # A2A-specific metadata — NULL for plain /run jobs
        sa.Column("a2a_flow_id", sa.Text(), nullable=True),
        sa.Column("a2a_message", sa.Text(), nullable=True),
    )

    op.create_index("ix_jobs_user_id", "jobs", ["user_id"], unique=False)
    op.create_index("ix_jobs_status_ended_at", "jobs", ["status", "ended_at"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_jobs_status_ended_at", table_name="jobs", if_exists=True)
    op.drop_index("ix_jobs_user_id", table_name="jobs", if_exists=True)
    op.drop_table("jobs", if_exists=True)
