"""SSO / OIDC columns on users table

Revision ID: 0008
Revises: 0007
Create Date: 2026-05-21

Adds columns needed for SSO and SCIM:

  users.sso_sub          TEXT  — OIDC subject (sub) claim, unique per provider.
                                  NULL for password-only accounts.
  users.sso_provider     TEXT  — provider name (e.g. "keycloak"), NULL for local accounts.
  users.is_active        BOOL  — SCIM deactivation flag (default TRUE).
                                  False blocks login for both SSO and password accounts.
  users.last_login_at    TIMESTAMPTZ — updated on every successful login.

Index:
  ix_users_sso_sub  — fast lookup by (sso_sub, sso_provider) for SSO callback provisioning.

Backward compatibility:
  - All new columns are nullable or have defaults so existing rows are unchanged.
  - password_hash is already used as a sentinel ("DEACTIVATED") by SCIM PATCH;
    the new is_active column provides a cleaner signal and is checked in current_user().
"""

import sqlalchemy as sa
from alembic import op

revision: str = "0008"
down_revision: str = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Add SSO identity columns.
    op.add_column("users", sa.Column("sso_sub", sa.Text, nullable=True))
    op.add_column("users", sa.Column("sso_provider", sa.Text, nullable=True))
    op.add_column("users", sa.Column("is_active", sa.Boolean, nullable=False, server_default=sa.text("TRUE")))
    op.add_column("users", sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True))

    # Composite index for SSO callback lookup (sub + provider).
    op.create_index(
        "ix_users_sso_sub",
        "users",
        ["sso_sub", "sso_provider"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_users_sso_sub", table_name="users")
    op.drop_column("users", "last_login_at")
    op.drop_column("users", "is_active")
    op.drop_column("users", "sso_provider")
    op.drop_column("users", "sso_sub")
