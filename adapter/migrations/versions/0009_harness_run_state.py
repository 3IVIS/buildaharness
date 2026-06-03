"""Add harness_run_state table and is_harness_run flag on jobs

Revision ID: 0009
Revises: 0008
Create Date: 2026-06-03

Creates the harness_run_state table that stores all 13 harness state
structures (world_model, caller_state, output_contract, hypothesis_set,
evidence_store, task_graph, diagnostics, control_state, memory_state,
strategy_state, failure_diagnostics, experience_store_ref, belief_dep_graph)
per run_id as JSONB columns.

Also adds is_harness_run BOOLEAN (default FALSE) to the jobs table so the
GET /runs/{job_id}/harness-state endpoint can return 404 without querying
harness_run_state for non-harness runs.

Backward compatibility:
  - All new columns default to FALSE / empty JSONB — existing rows unchanged.
  - harness_run_state is an independent table; no existing tables are modified
    except jobs (additive column only).
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0009"
down_revision: str = "0008"
branch_labels = None
depends_on = None

# Columns that store harness state structures as JSONB
_STATE_COLUMNS = [
    "world_model",
    "caller_state",
    "output_contract",
    "hypothesis_set",
    "evidence_store",
    "task_graph",
    "diagnostics",
    "control_state",
    "memory_state",
    "strategy_state",
    "failure_diagnostics",
    "experience_store_ref",
    "belief_dep_graph",
]


def upgrade() -> None:
    # Detect dialect — tests run on SQLite which does not support JSONB.
    bind = op.get_bind()
    is_postgres = bind.dialect.name == "postgresql"
    jsonb_type = JSONB() if is_postgres else sa.Text()

    op.create_table(
        "harness_run_state",
        sa.Column("run_id", sa.Text, primary_key=True),
        *[
            sa.Column(col, jsonb_type, nullable=False, server_default=sa.text("'{}'" if is_postgres else "'{}'"))
            for col in _STATE_COLUMNS
        ],
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    op.add_column(
        "jobs",
        sa.Column("is_harness_run", sa.Boolean, nullable=False, server_default=sa.text("FALSE")),
    )


def downgrade() -> None:
    op.drop_column("jobs", "is_harness_run")
    op.drop_table("harness_run_state")
