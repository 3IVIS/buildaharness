"""Storage and judgement protocols for agent memory. Interfaces only: no implementation, no DB imports.

``MemoryStore`` mirrors the TS key-value shape so the service is a line-for-line port. "Absent"
(``None``) and "empty" (``[]``) are distinguishable: undo of a change that created a side store
must leave it absent again. Keys are the wire names from the contract (see ``STORE_KEYS``).

Implementations: ``store_memory.py`` (in-process, tests) and ``store_sql.py`` (SQLAlchemy). The
clock and every semantic judgement are injected callables, never imported here.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from contextlib import AbstractAsyncContextManager
from typing import Any, Protocol, runtime_checkable

from .gate import Judge
from .model import Candidate

# Zero-argument callable returning an ISO-8601 string. The service never reads the wall clock itself.
Clock = Callable[[], str]

# One model call: user text in, one candidate per stated fact out (judgement fields filled in).
Extractor = Callable[[str], Awaitable[list[Candidate]]]


@runtime_checkable
class MemoryStore(Protocol):
    async def get_list(self, owner: str, key: str) -> list[dict[str, Any]] | None:
        """The list stored under ``key`` for ``owner``, or ``None`` when absent."""
        ...

    async def set_list(self, owner: str, key: str, items: list[dict[str, Any]]) -> None:
        """Replace the whole list (order preserved)."""
        ...

    async def delete(self, owner: str, key: str) -> None:
        """Make ``key`` absent (a no-op if it already is)."""
        ...

    async def get_state(self, owner: str, key: str) -> dict[str, Any] | None:
        """A single JSON object under ``key`` (e.g. the off switch), or ``None`` when absent."""
        ...

    async def set_state(self, owner: str, key: str, value: dict[str, Any]) -> None: ...

    def transaction(self, owner: str) -> AbstractAsyncContextManager[None]:
        """Serialise writers for one owner: ``async with store.transaction(owner): ...``."""
        ...


__all__ = ["Clock", "Extractor", "Judge", "MemoryStore"]
