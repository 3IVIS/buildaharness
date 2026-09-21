"""Optional plugin modules, discovered from a manifest that a checkout may or may not carry.

A plain clone has no manifest, so nothing is loaded and every hook that asks for plugins is a no-op.
A checkout with extra, separately maintained modules lists them in ``plugins.toml`` next to this
file, grouped by the kind of hook that should load them::

    routers = ["some_router_module"]     # each module exposes ``router`` (a FastAPI APIRouter)
    tool_impls = ["some_tools_module"]   # each module exposes ``EXTRA_TOOL_IMPLS`` (a dict)

Each hook site asks for only its own kind, at the same point in its module's import sequence that
an inline ``try: import ...`` would sit, so import order (and any import cycle) is unchanged.
"""

from __future__ import annotations

import importlib
import logging
import tomllib
from pathlib import Path
from types import ModuleType

logger = logging.getLogger(__name__)

DEFAULT_MANIFEST = Path(__file__).resolve().parent / "plugins.toml"


def plugin_names(kind: str, manifest: Path | None = None) -> list[str]:
    """Module names listed under ``kind``; empty when there is no manifest or no such kind.

    A manifest that exists but is malformed raises ``ValueError``: it is configuration someone
    wrote on purpose, so failing loudly beats silently loading nothing.
    """
    path = manifest or DEFAULT_MANIFEST
    if not path.is_file():
        return []
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise ValueError(f"invalid plugin manifest {path}: {exc}") from exc
    names = data.get(kind, [])
    if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
        raise ValueError(f"invalid plugin manifest {path}: `{kind}` must be a list of module names")
    return names


def load_plugin_modules(kind: str, manifest: Path | None = None) -> list[ModuleType]:
    """Import every module listed under ``kind``, in manifest order.

    A listed module that cannot be imported is logged (with its traceback) and skipped, so one
    broken plugin does not take the adapter down — but unlike a bare ``except ImportError: pass``,
    the failure is visible.
    """
    modules: list[ModuleType] = []
    for name in plugin_names(kind, manifest):
        try:
            modules.append(importlib.import_module(name))
        except ImportError:
            logger.warning("plugin %r (listed under %r) could not be imported; skipping it", name, kind, exc_info=True)
    return modules
