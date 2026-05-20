"""Unified deployments — REST + MCP + A2A one-click deploy

Revision ID: 0006
Revises: 0005
Create Date: 2026-05-19

Adds a unified_deployments table that records all three deployment targets
(REST endpoint, MCP tool manifest, A2A agent) produced by a single
POST /deploy/{flow_id} call.

The existing a2a_deployments table is left untouched for backward
compatibility.  POST /deploy/{flow_id} upserts both tables when the flow has
a2a_config.enabled=true, keeping them consistent.

Schema:
  NEW TABLE: unified_deployments
    id             UUID PK
    flow_id        TEXT FK → flows.id  UNIQUE (one unified deployment per flow)
    user_id        UUID FK → users.id
    org_id         UUID FK → orgs.id   nullable
    rest_url       TEXT    POST {BASE}/flows/{flow_id}/invoke
    mcp_url        TEXT    GET  {BASE}/.well-known/mcp/{flow_id}.json
    a2a_url        TEXT    POST {BASE}/a2a/{flow_id}/tasks/send  (null if A2A disabled)
    shareable_url  TEXT    GET  {BASE}/share/{flow_id}
    mcp_manifest   JSONB   MCP tool manifest snapshot at deploy time
    deployed_at    TIMESTAMPTZ

Indexes:
    ix_unified_deployments_user_id
    ix_unified_deployments_org_id

Downgrade: drops unified_deployments.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "unified_deployments",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "flow_id",
            sa.Text(),
            sa.ForeignKey("flows.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "org_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("orgs.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("rest_url",      sa.Text(), nullable=False),
        sa.Column("mcp_url",       sa.Text(), nullable=False),
        sa.Column("a2a_url",       sa.Text(), nullable=True),
        sa.Column("shareable_url", sa.Text(), nullable=False),
        sa.Column(
            "mcp_manifest",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default="{}",
        ),
        sa.Column(
            "deployed_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index("ix_unified_deployments_user_id", "unified_deployments", ["user_id"])
    op.create_index("ix_unified_deployments_org_id",  "unified_deployments", ["org_id"])


def downgrade() -> None:
    op.drop_index("ix_unified_deployments_org_id",  table_name="unified_deployments")
    op.drop_index("ix_unified_deployments_user_id", table_name="unified_deployments")
    op.drop_table("unified_deployments")
