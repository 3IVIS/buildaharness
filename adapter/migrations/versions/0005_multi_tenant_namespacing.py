"""Multi-tenant namespacing — orgs table + org_id columns

Revision ID: 0005
Revises: 0004
Create Date: 2026-05-19

Adds first-class org (organisation) isolation so every data object is scoped
to an org rather than just to a user.  Every user gets a personal org on
registration; teams can be promoted to org-level.

Schema changes:

  NEW TABLE: orgs
    id              UUID PK
    name            TEXT
    owner_id        UUID FK → users.id  (the user who created the org)
    langfuse_public_key   TEXT  — per-org Langfuse project key (null = use global)
    langfuse_secret_key   TEXT  — per-org Langfuse secret key (null = use global)
    created_at      TIMESTAMPTZ

  NEW TABLE: org_memberships
    id       UUID PK
    org_id   UUID FK → orgs.id
    user_id  UUID FK → users.id
    role     TEXT  (admin | member)
    created_at TIMESTAMPTZ
    UNIQUE (org_id, user_id)

  ADDED COLUMN:  flows.org_id          UUID FK → orgs.id  (nullable → filled by data migration)
  ADDED COLUMN:  jobs.org_id           UUID FK → orgs.id  (nullable)
  ADDED COLUMN:  a2a_deployments.org_id UUID FK → orgs.id (nullable)
  ADDED COLUMN:  teams.org_id          UUID FK → orgs.id  (nullable)

  NEW INDEXES:
    ix_flows_org_id
    ix_jobs_org_id
    ix_a2a_deployments_org_id
    ix_org_memberships_user_id

Data migration strategy:
  1. Create one personal org per existing user (name = user's email prefix).
  2. Set org_id on all their existing flows, jobs, and a2a_deployments.
  3. Existing teams are not auto-promoted to org-level (null org_id is fine —
     teams are an RBAC layer; org isolation is a separate concept).

Downgrade:
  Drops the added columns and both new tables.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ── 1. Create orgs table ──────────────────────────────────────────────────
    op.create_table(
        "orgs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column(
            "owner_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        # Per-org Langfuse project keys.  NULL means "use the global env-var keys".
        # Stored as plain text — at rest encryption is at the infrastructure level
        # (Postgres TDE or disk encryption).  In a future pass these can be
        # encrypted with the LANGFUSE_ENCRYPTION_KEY before insert.
        sa.Column("langfuse_public_key", sa.Text(), nullable=True),
        sa.Column("langfuse_secret_key", sa.Text(), nullable=True),
        sa.Column("is_personal", sa.Text(), nullable=False, server_default="false"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index("ix_orgs_owner_id", "orgs", ["owner_id"], unique=False)
    # Partial unique index: each user can have at most one personal org.
    # Prevents duplicates from concurrent first-requests (registration race).
    op.create_index(
        "ix_orgs_personal_per_owner",
        "orgs",
        ["owner_id"],
        unique=True,
        postgresql_where=sa.text("is_personal = 'true'"),
    )

    # ── 2. Create org_memberships table ───────────────────────────────────────
    op.create_table(
        "org_memberships",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "org_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("orgs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("role", sa.Text(), nullable=False, server_default="member"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint("org_id", "user_id", name="uq_org_memberships_org_user"),
    )
    op.create_index("ix_org_memberships_user_id", "org_memberships", ["user_id"], unique=False)
    op.create_index("ix_org_memberships_org_id", "org_memberships", ["org_id"], unique=False)

    # ── 3. Add org_id columns ─────────────────────────────────────────────────
    for table in ("flows", "jobs", "a2a_deployments", "teams"):
        op.add_column(
            table,
            sa.Column(
                "org_id",
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey("orgs.id", ondelete="SET NULL"),
                nullable=True,  # nullable so the column can be added to existing rows
            ),
        )
        op.create_index(f"ix_{table}_org_id", table, ["org_id"], unique=False)

    # ── 4. Data migration — personal orgs for existing users ──────────────────
    #
    # For every existing user:
    #   a. INSERT a personal org (name = email prefix, owner = user).
    #   b. INSERT an org_membership (admin role).
    #   c. UPDATE flows/jobs/a2a_deployments to point at that user's org.
    #
    # This runs inside the Alembic transaction so it's atomic with the schema
    # changes above.  On a large dataset a separate migration step or a
    # background job would be preferable; for the typical itsharness install
    # (tens to hundreds of users) this is fine inline.

    conn = op.get_bind()

    users = conn.execute(sa.text("SELECT id, email FROM users")).fetchall()

    for row in users:
        uid = row[0]
        email = row[1]
        name = email.split("@")[0] if email and "@" in email else str(uid)[:8]

        # Create personal org.
        org_id_row = conn.execute(
            sa.text("INSERT INTO orgs (name, owner_id, is_personal) VALUES (:name, :owner_id, 'true') RETURNING id"),
            {"name": f"{name}'s workspace", "owner_id": uid},
        ).fetchone()
        org_id = org_id_row[0]

        # Membership (admin of own org).
        conn.execute(
            sa.text("INSERT INTO org_memberships (org_id, user_id, role) VALUES (:org_id, :user_id, 'admin')"),
            {"org_id": org_id, "user_id": uid},
        )

        # Scope existing data to this org.
        for table, id_col in [("flows", "user_id"), ("jobs", "user_id"), ("a2a_deployments", "user_id")]:
            conn.execute(
                sa.text(f"UPDATE {table} SET org_id = :org_id WHERE {id_col} = :uid"),
                {"org_id": org_id, "uid": uid},
            )


def downgrade() -> None:
    for table in ("teams", "a2a_deployments", "jobs", "flows"):
        op.drop_index(f"ix_{table}_org_id", table_name=table, if_exists=True)
        op.drop_column(table, "org_id")

    op.drop_index("ix_org_memberships_org_id", table_name="org_memberships", if_exists=True)
    op.drop_index("ix_org_memberships_user_id", table_name="org_memberships", if_exists=True)
    op.drop_table("org_memberships", if_exists=True)

    op.drop_index("ix_orgs_personal_per_owner", table_name="orgs", if_exists=True)
    op.drop_index("ix_orgs_owner_id", table_name="orgs", if_exists=True)
    op.drop_table("orgs", if_exists=True)
