"""Team RBAC — teams, team_memberships, flow_permissions

Revision ID: 0002
Revises: 0001
Create Date: 2026-05-17

Adds the three tables that underpin Phase 3 team features:

  teams               — named groups, owned by a user
  team_memberships    — user ↔ team many-to-many with a role column
  flow_permissions    — flow ↔ team grants (view | edit)

Downgrade drops all three tables (safe — they are new and have no data
on a freshly-migrated instance).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ── teams ─────────────────────────────────────────────────────────────────
    op.create_table(
        "teams",
        sa.Column("id",         postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name",       sa.Text(), nullable=False),
        sa.Column(
            "created_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )

    # ── team_memberships ──────────────────────────────────────────────────────
    # role values: 'admin' | 'editor' | 'viewer'
    op.create_table(
        "team_memberships",
        sa.Column("id",      postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "team_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("teams.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("role",       sa.Text(), nullable=False, server_default="viewer"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint("team_id", "user_id", name="uq_team_memberships_team_user"),
    )
    op.create_index(
        "ix_team_memberships_user_id", "team_memberships", ["user_id"], unique=False,
    )

    # ── flow_permissions ──────────────────────────────────────────────────────
    # permission values: 'view' | 'edit'
    op.create_table(
        "flow_permissions",
        sa.Column("id",      postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "flow_id",
            sa.Text(),
            sa.ForeignKey("flows.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "team_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("teams.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("permission", sa.Text(), nullable=False, server_default="view"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint("flow_id", "team_id", name="uq_flow_permissions_flow_team"),
    )
    op.create_index(
        "ix_flow_permissions_flow_id", "flow_permissions", ["flow_id"], unique=False,
    )
    op.create_index(
        "ix_flow_permissions_team_id", "flow_permissions", ["team_id"], unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_flow_permissions_team_id", table_name="flow_permissions", if_exists=True)
    op.drop_index("ix_flow_permissions_flow_id", table_name="flow_permissions", if_exists=True)
    op.drop_table("flow_permissions", if_exists=True)
    op.drop_index("ix_team_memberships_user_id", table_name="team_memberships", if_exists=True)
    op.drop_table("team_memberships", if_exists=True)
    op.drop_table("teams", if_exists=True)
