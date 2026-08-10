"""Add promotion boundary to experience store tables — Phase 2 of
plans/harness_and_assistant_architecture_remediation_plan.html

Revision ID: 0012
Revises: 0011
Create Date: 2026-08-10

Adds `promoted boolean NOT NULL DEFAULT false` to both experience-store tables. Before
this, update_experience_store() wrote directly into the same rows warm_start() read on
the very next run — "immediate learning," not "immutable trace -> offline learning ->
candidate policy -> evaluation -> promotion -> future runs" (docs/adr/002-harness-
semantic-contract.md's guarantee #8). Every write now lands as an unpromoted candidate;
only an explicit, separate promote_experience_entries()/promote_strategy_weights() call
(never invoked automatically by update_experience_store or the main loop) makes a
candidate visible to query_by_type()/get_strategy_weights(), and so to warm_start().
"""

import sqlalchemy as sa
from alembic import op

revision: str = "0012"
down_revision: str = "0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "experience_entries",
        sa.Column("promoted", sa.Boolean, nullable=False, server_default=sa.false()),
    )
    op.add_column(
        "experience_strategy_weights",
        sa.Column("promoted", sa.Boolean, nullable=False, server_default=sa.false()),
    )
    op.create_index(
        "ix_experience_entries_promoted",
        "experience_entries",
        ["entry_type", "promoted"],
    )


def downgrade() -> None:
    op.drop_index("ix_experience_entries_promoted", "experience_entries")
    op.drop_column("experience_strategy_weights", "promoted")
    op.drop_column("experience_entries", "promoted")
