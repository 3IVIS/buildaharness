"""
Twin of packages/harness/src/harness-checkpoint.ts: the checkpoint a run yields at each suspend point.

The wire format is the TS one (camelCase top-level keys, snake_case state structures, `schemaVersion`), so a
checkpoint written by either runtime can be resumed by the other. The state structures themselves are validated
against the TS zod schemas by `adapter/tests/test_harness_ts_state_shapes.py`.

Suspend points (same as TS): a proposed action before it executes (`pendingProposal.kind == "proposal"`), a
continuable execution that wants another attempt (`kind == "continuation"`), and the end of every iteration.
"""

from __future__ import annotations

import warnings
from collections.abc import Callable
from typing import Any, Protocol

CHECKPOINT_SCHEMA_VERSION = 2

Checkpoint = dict[str, Any]


def _migrate_v1(raw: Checkpoint) -> Checkpoint:
    """v1 → v2: a legacy pendingProposal had no `kind`; it was always a fresh proposal."""
    progress = dict(raw["progress"])
    legacy = progress.get("pendingProposal")
    progress["pendingProposal"] = {**legacy, "kind": "proposal"} if legacy else None
    return {**raw, "progress": progress, "schemaVersion": 2}


CHECKPOINT_MIGRATIONS: dict[int, Callable[[Checkpoint], Checkpoint]] = {1: _migrate_v1}


class CheckpointSchemaError(Exception):
    def __init__(self, found_version: int, current_version: int) -> None:
        self.found_version = found_version
        self.current_version = current_version
        if found_version > current_version:
            msg = (
                f"Checkpoint schema version {found_version} is newer than this build understands "
                f"(current: {current_version}). Refusing to read it rather than silently misinterpreting its shape."
            )
        else:
            msg = (
                f"Checkpoint schema version {found_version} has no migration path to {current_version}. "
                "Refusing to read it rather than letting a stale-shape read throw deep inside a state "
                "structure's from_dict()."
            )
        super().__init__(msg)


def _read_version(checkpoint: Checkpoint) -> int:
    version = checkpoint.get("schemaVersion")
    return 1 if version is None else int(version)  # TS `?? 1`: a 0 stays 0 (no migration path)


def assert_checkpoint_schema_current(checkpoint: Checkpoint) -> Checkpoint:
    """Migrate `checkpoint` to the current schema or raise CheckpointSchemaError (TS assertCheckpointSchemaCurrent)."""
    current = checkpoint
    version = _read_version(current)
    while version < CHECKPOINT_SCHEMA_VERSION:
        migrate = CHECKPOINT_MIGRATIONS.get(version)
        if migrate is None:
            raise CheckpointSchemaError(version, CHECKPOINT_SCHEMA_VERSION)
        current = migrate(current)
        version = _read_version(current)
    if version > CHECKPOINT_SCHEMA_VERSION:
        raise CheckpointSchemaError(version, CHECKPOINT_SCHEMA_VERSION)
    return current


class CheckpointStore(Protocol):
    """Minimal key-value store (TS CheckpointStore, synchronous)."""

    def get(self, key: str) -> Any: ...

    def set(self, key: str, value: Any) -> None: ...

    def delete(self, key: str) -> None: ...


def checkpoint_key(run_id: str) -> str:
    return f"harness-checkpoint:{run_id}"


def save_harness_checkpoint(store: CheckpointStore, checkpoint: Checkpoint) -> None:
    store.set(checkpoint_key(checkpoint["runId"]), checkpoint)


def load_harness_checkpoint(store: CheckpointStore, run_id: str) -> Checkpoint | None:
    """Load and migrate a checkpoint; an unreadable schema is discarded with a warning (TS loadHarnessCheckpoint)."""
    value = store.get(checkpoint_key(run_id))
    if value is None:
        return None
    try:
        return assert_checkpoint_schema_current(value)
    except CheckpointSchemaError as err:
        warnings.warn(
            f'load_harness_checkpoint: discarding unreadable checkpoint for runId="{run_id}": {err}', stacklevel=2
        )
        store.delete(checkpoint_key(run_id))
        return None


def delete_harness_checkpoint(store: CheckpointStore, run_id: str) -> None:
    store.delete(checkpoint_key(run_id))
