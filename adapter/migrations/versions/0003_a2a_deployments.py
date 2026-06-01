"""a2a_deployments — persists deployed A2A agent records

Revision ID: 0003
Revises: 0002
Create Date: 2026-05-18

One row per deployed flow.  Re-deploying the same flow upserts (updates)
the existing row so external agents always discover a stable URL.

Columns:
  id            UUID PK
  flow_id       TEXT FK → flows.id  (unique — one deployment per flow)
  user_id       UUID FK → users.id
  endpoint_url  TEXT — the /a2a/{flow_id}/tasks/send URL
  agent_card    JSONB — snapshot of the AgentCard at deploy time
  deployed_at   TIMESTAMPTZ

Downgrade drops the table (safe — no other tables depend on it).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "a2a_deployments",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "flow_id",
            sa.Text(),
            sa.ForeignKey("flows.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,  # one deployment per flow
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("endpoint_url", sa.Text(), nullable=False),
        sa.Column("agent_card", postgresql.JSONB(), nullable=False),
        sa.Column(
            "deployed_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_a2a_deployments_user_id",
        "a2a_deployments",
        ["user_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_a2a_deployments_user_id", table_name="a2a_deployments", if_exists=True)
    op.drop_table("a2a_deployments", if_exists=True)
