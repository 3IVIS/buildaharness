"""In-memory MemoryStore: the conformance runner's and unit tests' store.

Same contract as ``SqlMemoryStore`` (owner scoping, absent vs empty, per-owner transaction that
serialises writers and rolls back on failure) with no database.  Values are deep-copied on the
way in and out so callers can never alias stored state.
"""

from __future__ import annotations

import asyncio
import copy
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from ._core_generated import STORE_KEYS

_AUDIT_KEY = STORE_KEYS["audit"]
_FACTS_PREFIX = "facts:"


def _is_list_key(key: str) -> bool:
    return key == _AUDIT_KEY or key.startswith(_FACTS_PREFIX)


class InMemoryMemoryStore:
    def __init__(self) -> None:
        self._data: dict[str, dict[str, Any]] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._holders: dict[str, asyncio.Task[Any] | None] = {}

    def _bucket(self, owner: str) -> dict[str, Any]:
        return self._data.setdefault(owner, {})

    async def get_list(self, owner: str, key: str) -> list[dict[str, Any]] | None:
        if not _is_list_key(key):
            raise ValueError(f"not a list key: {key!r}")
        v = self._data.get(owner, {}).get(key)
        return None if v is None else copy.deepcopy(v)

    async def set_list(self, owner: str, key: str, items: list[dict[str, Any]]) -> None:
        if not _is_list_key(key):
            raise ValueError(f"not a list key: {key!r}")
        self._bucket(owner)[key] = copy.deepcopy(list(items))

    async def get_state(self, owner: str, key: str) -> dict[str, Any] | None:
        if _is_list_key(key):
            raise ValueError(f"not a state key: {key!r}")
        v = self._data.get(owner, {}).get(key)
        return None if v is None else copy.deepcopy(v)

    async def set_state(self, owner: str, key: str, value: dict[str, Any]) -> None:
        if _is_list_key(key):
            raise ValueError(f"not a state key: {key!r}")
        self._bucket(owner)[key] = copy.deepcopy(value)

    async def delete(self, owner: str, key: str) -> None:
        self._data.get(owner, {}).pop(key, None)

    async def keys(self, owner: str) -> list[str]:
        return sorted(self._data.get(owner, {}))

    async def clear_owner(self, owner: str) -> None:
        self._data.pop(owner, None)

    @asynccontextmanager
    async def transaction(self, owner: str) -> AsyncIterator[None]:
        lock = self._locks.setdefault(owner, asyncio.Lock())
        task = asyncio.current_task()
        if task is not None and self._holders.get(owner) is task:  # re-entrant for the owning task
            yield
            return
        async with lock:
            self._holders[owner] = task
            snapshot = copy.deepcopy(self._data.get(owner))
            try:
                yield
            except BaseException:
                if snapshot is None:
                    self._data.pop(owner, None)
                else:
                    self._data[owner] = snapshot
                raise
            finally:
                self._holders[owner] = None
