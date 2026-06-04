"""
Tool availability manifest — P1.3.

A frozen record built once at harness init that records which tools are
present in the runtime environment and what fallbacks exist. Read-only
after construction — runtime mutation raises FrozenManifestError.

The manifest is always rebuilt at harness init (not restored from store) to
ensure it reflects the current runtime environment, not the environment at
first-run time.
"""

from __future__ import annotations

import shutil
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any


class FrozenManifestError(Exception):
    pass


@dataclass
class ToolEntry:
    tool_name: str
    available: bool
    fallback_tool: str | None


class ToolAvailabilityManifest:
    def __init__(self) -> None:
        self._entries: dict[str, ToolEntry] = {}
        self._frozen: bool = False

    def _freeze(self) -> None:
        self._frozen = True

    def _check_frozen(self) -> None:
        if self._frozen:
            raise FrozenManifestError("Cannot modify a frozen ToolAvailabilityManifest")

    def _register(self, entry: ToolEntry) -> None:
        self._check_frozen()
        self._entries[entry.tool_name] = entry

    def check_tool_availability(self, tool_name: str) -> bool:
        return self._entries.get(tool_name, ToolEntry(tool_name, False, None)).available

    def get_fallback(self, tool_name: str) -> str | None:
        entry = self._entries.get(tool_name)
        if entry is None or entry.fallback_tool is None:
            return None
        if self.check_tool_availability(entry.fallback_tool):
            return entry.fallback_tool
        return None

    def all_tools(self) -> list[str]:
        return sorted(self._entries.keys())

    def to_dict(self) -> dict[str, Any]:
        return {
            "entries": {
                name: {
                    "tool_name": e.tool_name,
                    "available": e.available,
                    "fallback_tool": e.fallback_tool,
                }
                for name, e in self._entries.items()
            }
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> ToolAvailabilityManifest:
        manifest = cls()
        for _name, entry_data in d.get("entries", {}).items():
            manifest._entries[entry_data["tool_name"]] = ToolEntry(
                tool_name=entry_data["tool_name"],
                available=entry_data["available"],
                fallback_tool=entry_data.get("fallback_tool"),
            )
        return manifest


_DEFAULT_FALLBACKS: dict[str, str] = {
    "pylint": "ruff",
    "mypy": "pyright",
}

_DEFAULT_TOOLS = ["grep", "pylint", "mypy", "pytest", "ruff", "pyright"]


def build_manifest(
    runtime_checks: dict[str, Callable[[], bool]] | None = None,
) -> ToolAvailabilityManifest:
    """Build a frozen manifest by probing tool availability.

    Default probe: shutil.which(tool_name) is not None.
    Custom probes can be injected via runtime_checks (used in tests).
    A probe that raises is treated as unavailable — the exception is not
    propagated.
    """
    manifest = ToolAvailabilityManifest()

    tools_to_check = list(_DEFAULT_TOOLS)
    if runtime_checks:
        for tool in runtime_checks:
            if tool not in tools_to_check:
                tools_to_check.append(tool)

    for tool_name in tools_to_check:
        probe = (runtime_checks or {}).get(tool_name)
        available = False
        try:
            if probe is not None:
                available = bool(probe())
            else:
                available = shutil.which(tool_name) is not None
        except Exception:
            available = False

        fallback = _DEFAULT_FALLBACKS.get(tool_name)
        manifest._register(
            ToolEntry(
                tool_name=tool_name,
                available=available,
                fallback_tool=fallback,
            )
        )

    manifest._freeze()
    return manifest
