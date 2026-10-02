"""Create agent memory tables - M8 (user-fact memory for adapter-side agents)

Revision ID: 0013
Revises: 0012
Create Date: 2026-10-02

Creates three tables (see plans/agent_memory_framework_plan.html, M8 scoping
addendum, section 3):
  agent_memory_facts  - every fact list, one row per fact, ordered by position.
                        The ``store`` column holds the contract key name
                        (facts:durable, facts:<sessionId>, facts:pending-confirmation,
                        facts:rejected, facts:retired).  position -1 is the
                        "present but empty" sentinel row, so an absent list and an
                        empty list stay distinguishable.
  agent_memory_audit  - the append-only audit log, primary key (owner_id, seq) so two
                        racing appends cannot both claim one seq.  seq 0 is the
                        "present but empty" sentinel row.
  agent_memory_state  - small per-owner values (memory:off, memory:consolidation-state).

Every row is scoped by an opaque ``owner_id`` string supplied by the caller.
"""

import uuid
from typing import Any

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "0013"
down_revision: str = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    is_postgres = bind.dialect.name == "postgresql"
    jsonb_type: sa.types.TypeEngine[Any] = JSONB() if is_postgres else sa.Text()
    uuid_type: sa.types.TypeEngine[str] = UUID(as_uuid=False) if is_postgres else sa.String(36)

    op.create_table(
        "agent_memory_facts",
        sa.Column("id", uuid_type, primary_key=True, default=lambda: str(uuid.uuid4())),
        sa.Column("owner_id", sa.String, nullable=False),
        sa.Column("store", sa.String, nullable=False),
        sa.Column("position", sa.Integer, nullable=False),
        sa.Column("fact_id", sa.String, nullable=False, server_default=""),
        sa.Column("payload", jsonb_type, nullable=False),
        sa.Column("created_at", sa.TIMESTAMP, nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.UniqueConstraint("owner_id", "store", "position", name="uq_agent_memory_facts_owner_store_pos"),
    )
    op.create_index("ix_agent_memory_facts_owner_store", "agent_memory_facts", ["owner_id", "store"])

    op.create_table(
        "agent_memory_audit",
        sa.Column("owner_id", sa.String, nullable=False),
        sa.Column("seq", sa.Integer, nullable=False),
        sa.Column("at", sa.TIMESTAMP, nullable=True),
        sa.Column("op", sa.String, nullable=False, server_default=""),
        sa.Column("store", sa.String, nullable=False, server_default=""),
        sa.Column("fact_id", sa.String, nullable=False, server_default=""),
        sa.Column("payload", jsonb_type, nullable=False),
        sa.PrimaryKeyConstraint("owner_id", "seq", name="pk_agent_memory_audit"),
    )

    op.create_table(
        "agent_memory_state",
        sa.Column("owner_id", sa.String, nullable=False),
        sa.Column("key", sa.String, nullable=False),
        sa.Column("value", jsonb_type, nullable=False),
        sa.PrimaryKeyConstraint("owner_id", "key", name="pk_agent_memory_state"),
    )


def downgrade() -> None:
    op.drop_table("agent_memory_state")
    op.drop_table("agent_memory_audit")
    op.drop_index("ix_agent_memory_facts_owner_store", "agent_memory_facts")
    op.drop_table("agent_memory_facts")
