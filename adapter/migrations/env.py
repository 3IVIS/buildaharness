"""
Alembic environment for itsharness adapter.

Uses SQLAlchemy async engine (asyncpg in production, aiosqlite in tests).
DATABASE_URL is read from the environment — it must already be set before
`alembic upgrade head` runs (either via .env loaded by the shell, or injected
by docker-compose).

Run migrations:
    cd adapter/
    alembic upgrade head          # apply all pending migrations
    alembic revision --autogenerate -m "describe change"   # generate new migration
    alembic downgrade -1          # roll back the most recent migration
"""

import asyncio
import os
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

# ── Import ORM metadata so Alembic can diff against the live DB ──────────────
# db.py reads DATABASE_URL at import time; env.py must set it first when the var
# is not already present (e.g. during `alembic revision --autogenerate` on a dev
# machine that hasn't sourced .env).
_db_url = os.getenv("DATABASE_URL")
if not _db_url:
    raise RuntimeError(
        "DATABASE_URL environment variable is not set.\n"
        "Export it before running alembic:\n"
        "  export DATABASE_URL=postgresql+asyncpg://user:pass@host:5432/dbname"
    )

from db import Base  # noqa: E402 — must come after DATABASE_URL check

# ── Alembic config object ─────────────────────────────────────────────────────
config = context.config

# Inject DATABASE_URL from env so the ini file never holds a secret.
config.set_main_option("sqlalchemy.url", _db_url)

# Interpret the config file for Python logging.
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


# ── Offline mode (generate SQL without a live DB connection) ──────────────────


def run_migrations_offline() -> None:
    """Emit SQL to stdout without an active DB connection.

    Used with: alembic upgrade head --sql > migration.sql
    """
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        # Compare server defaults so Alembic notices DEFAULT changes.
        compare_server_default=True,
    )
    with context.begin_transaction():
        context.run_migrations()


# ── Online mode (run against a live DB) ──────────────────────────────────────


def do_run_migrations(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        # Detect column type changes (e.g. Text → UUID) that autogenerate
        # misses by default.
        compare_type=True,
        compare_server_default=True,
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    """Create an async engine and run migrations inside run_sync()."""
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        # NullPool: each migration opens and closes its own connection.
        # Avoids leaving idle connections after alembic upgrade head exits.
        poolclass=pool.NullPool,
    )
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)

    await connectable.dispose()


def run_migrations_online() -> None:
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
