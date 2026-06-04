"""Add escalation state columns to harness_run_state — P7

Revision ID: 0010
Revises: 0009
Create Date: 2026-06-04

Adds three columns to harness_run_state:
  escalation_pending   BOOLEAN   — True when the run is halted awaiting human input
  pending_escalation   JSONB     — SurfaceBlocker payload (reason, missing_info, etc.)
  pending_clarification JSONB    — Human response payload waiting for the run to resume

All columns default to FALSE / NULL — existing rows are unchanged.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0010"
down_revision: str = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    is_postgres = bind.dialect.name == "postgresql"
    jsonb_type = JSONB() if is_postgres else sa.Text()

    op.add_column(
        "harness_run_state",
        sa.Column(
            "escalation_pending",
            sa.Boolean,
            nullable=False,
            server_default=sa.text("FALSE"),
        ),
    )
    op.add_column(
        "harness_run_state",
        sa.Column("pending_escalation", jsonb_type, nullable=True),
    )
    op.add_column(
        "harness_run_state",
        sa.Column("pending_clarification", jsonb_type, nullable=True),
    )


def downgrade() -> None:
    op.drop_column("harness_run_state", "pending_clarification")
    op.drop_column("harness_run_state", "pending_escalation")
    op.drop_column("harness_run_state", "escalation_pending")
