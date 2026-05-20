"""Component marketplace — community_components table

Revision ID: 0007
Revises: 0006
Create Date: 2026-05-20

Adds the community_components table that backs the component marketplace v1.

Each row represents one published community component.  A component is a
pre-configured tool_invoke (or other node type) that a user can install from
the marketplace sidebar tab directly onto their canvas.

The node_spec JSONB column stores the full FlowSpec node fragment so the
install endpoint can return a ready-to-drop node without any further
resolution.  The tool_def JSONB column mirrors the ToolDef fields so
installed tools can be auto-registered in the flow's tools registry.

Schema
──────
  community_components
    id              UUID PK
    slug            TEXT UNIQUE NOT NULL  — URL-safe identifier, e.g. web-search
    name            TEXT NOT NULL         — display name, e.g. "Web Search"
    description     TEXT NOT NULL         — one-sentence description
    category        TEXT NOT NULL         — tool | memory | agent | control
    icon_emoji      TEXT NOT NULL DEFAULT '🔧'
    npm_ref         TEXT NOT NULL         — e.g. @langchain/community/tools/TavilySearchResults
    source          TEXT NOT NULL DEFAULT 'npm'  — npm | mcp | local
    node_spec       JSONB NOT NULL        — ready-to-use node fragment
    tool_def        JSONB                 — ToolDef to auto-register (tool nodes only)
    tags            JSONB NOT NULL DEFAULT '[]'  — searchable string array
    verified        TEXT NOT NULL DEFAULT 'false'  — 'true' for @itsharness/* packages
    author          TEXT NOT NULL DEFAULT '@itsharness'
    install_count   INTEGER NOT NULL DEFAULT 0
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()

Indexes
───────
  ix_community_components_slug      (unique — primary lookup key)
  ix_community_components_category  (sidebar category filter)
  ix_community_components_verified  (show verified-first in gallery)

Downgrade: drops community_components.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "community_components",
        sa.Column("id",            postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("slug",          sa.Text(), nullable=False, unique=True),
        sa.Column("name",          sa.Text(), nullable=False),
        sa.Column("description",   sa.Text(), nullable=False),
        sa.Column("category",      sa.Text(), nullable=False),
        sa.Column("icon_emoji",    sa.Text(), nullable=False, server_default="'🔧'"),
        sa.Column("npm_ref",       sa.Text(), nullable=False),
        sa.Column("source",        sa.Text(), nullable=False, server_default="'npm'"),
        sa.Column(
            "node_spec",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default="'{}'",
        ),
        sa.Column(
            "tool_def",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        sa.Column(
            "tags",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default="'[]'",
        ),
        sa.Column("verified",       sa.Text(), nullable=False, server_default="'false'"),
        sa.Column("author",         sa.Text(), nullable=False, server_default="'@itsharness'"),
        sa.Column("install_count",  sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index("ix_community_components_slug",     "community_components", ["slug"],     unique=True)
    op.create_index("ix_community_components_category", "community_components", ["category"])
    op.create_index("ix_community_components_verified", "community_components", ["verified"])


def downgrade() -> None:
    op.drop_index("ix_community_components_verified", table_name="community_components")
    op.drop_index("ix_community_components_category", table_name="community_components")
    op.drop_index("ix_community_components_slug",     table_name="community_components")
    op.drop_table("community_components")
