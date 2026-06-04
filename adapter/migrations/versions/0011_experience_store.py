"""Create experience store tables — P8.1

Revision ID: 0011
Revises: 0010
Create Date: 2026-06-04

Creates two tables:
  experience_entries            — stores structural patterns (decompositions,
                                  tool workflows, verification plans, etc.)
  experience_strategy_weights   — empirical success rates per (strategy, failure_class) pair
"""

import uuid

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "0011"
down_revision: str = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    is_postgres = bind.dialect.name == "postgresql"
    jsonb_type = JSONB() if is_postgres else sa.Text()
    uuid_type = UUID(as_uuid=False) if is_postgres else sa.String(36)

    op.create_table(
        "experience_entries",
        sa.Column("id", uuid_type, primary_key=True, default=lambda: str(uuid.uuid4())),
        sa.Column("entry_type", sa.String, nullable=False),
        sa.Column("failure_class", sa.String, nullable=True),
        sa.Column("task_class", sa.String, nullable=True),
        sa.Column("payload", jsonb_type, nullable=False, server_default="{}"),
        sa.Column("run_id", uuid_type, nullable=False),
        sa.Column(
            "created_at",
            sa.TIMESTAMP,
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
    )
    op.create_index(
        "ix_experience_entries_entry_type",
        "experience_entries",
        ["entry_type"],
    )
    op.create_index(
        "ix_experience_entries_task_class",
        "experience_entries",
        ["task_class"],
    )

    op.create_table(
        "experience_strategy_weights",
        sa.Column("id", uuid_type, primary_key=True, default=lambda: str(uuid.uuid4())),
        sa.Column("strategy_type", sa.String, nullable=False),
        sa.Column("failure_class", sa.String, nullable=False),
        sa.Column("success_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("attempt_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("rate", sa.Float, nullable=False, server_default="0.5"),
        sa.Column(
            "updated_at",
            sa.TIMESTAMP,
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.UniqueConstraint("strategy_type", "failure_class", name="uq_strategy_failure_class"),
    )
    op.create_index(
        "ix_experience_strategy_weights_failure_class",
        "experience_strategy_weights",
        ["failure_class"],
    )


def downgrade() -> None:
    op.drop_index("ix_experience_strategy_weights_failure_class", "experience_strategy_weights")
    op.drop_table("experience_strategy_weights")
    op.drop_index("ix_experience_entries_task_class", "experience_entries")
    op.drop_index("ix_experience_entries_entry_type", "experience_entries")
    op.drop_table("experience_entries")
