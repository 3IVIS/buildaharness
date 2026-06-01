"""Initial schema — users, flows, flow_versions

Revision ID: 0001
Revises:
Create Date: 2026-05-17

Captures the schema that was previously managed by SQLAlchemy's create_all().
On a fresh database this creates all three tables.
On an existing database that was bootstrapped by create_all() the tables
already exist, so each CREATE TABLE is guarded by checkfirst=True.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ── users ─────────────────────────────────────────────────────────────────
    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("email", sa.Text(), nullable=False, unique=True),
        sa.Column("password_hash", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        if_not_exists=True,
    )

    # ── flows ─────────────────────────────────────────────────────────────────
    op.create_table(
        "flows",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("current_spec", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        if_not_exists=True,
    )
    op.create_index("ix_flows_user_id", "flows", ["user_id"], unique=False, if_not_exists=True)

    # ── flow_versions ─────────────────────────────────────────────────────────
    op.create_table(
        "flow_versions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "flow_id",
            sa.Text(),
            sa.ForeignKey("flows.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("spec", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("version_num", sa.Integer(), nullable=False),
        sa.Column("label", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint("flow_id", "version_num", name="uq_flow_versions_flow_ver"),
        if_not_exists=True,
    )


def downgrade() -> None:
    op.drop_table("flow_versions", if_exists=True)
    op.drop_index("ix_flows_user_id", table_name="flows", if_exists=True)
    op.drop_table("flows", if_exists=True)
    op.drop_table("users", if_exists=True)
