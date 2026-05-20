"""
Prompt resolver — injects Langfuse-managed prompt text into llm_call nodes.

resolve_prompts(spec) walks every llm_call node in the spec.  For any node
that has a prompt_ref (name + optional version/label), it fetches the resolved
text from Langfuse and injects it into prompt_template so all downstream
adapters (LangGraph, CrewAI, Mastra) see a fully-populated spec with no
Langfuse dependency of their own.

Called from:
  - POST /compile   in main.py        — after validate_spec(), before codegen
  - POST /run       in run_api.py     — after validate_spec(), before background task

Caching:
  In-process dict with configurable TTL (default 60 s, env: PROMPT_CACHE_TTL).
  Cache key is "{org_id}:{name}:{version}:{label}" (or "global:{...}" when no
  org is provided) so different orgs and different version pins get independent
  entries.  Single-process only; no Redis needed.

Graceful degradation:
  If Langfuse is unreachable the node's existing prompt_template is left
  unchanged (may be empty string or a previously-set inline value).
  A WARNING is printed to stderr — no exception is raised.

TESTING=true:
  Returns the spec completely unchanged — no Langfuse calls, no cache writes,
  safe for the CI suite.
"""
import asyncio
import copy
import os
import time
from typing import Any

# ── Langfuse client (optional) ────────────────────────────────────────────────
try:
    from langfuse import get_client as _lf_get_client
    _LANGFUSE_ENABLED = bool(os.getenv("LANGFUSE_PUBLIC_KEY"))
except ImportError:
    _LANGFUSE_ENABLED = False

    def _lf_get_client():  # type: ignore[misc]
        return None


# ── Cache ─────────────────────────────────────────────────────────────────────

_CACHE_TTL: int = int(os.getenv("PROMPT_CACHE_TTL", "60"))

# {cache_key: {"text": str, "ts": float}}
# Thread-safe for single-process deployments (WEB_CONCURRENCY=1).
_cache: dict[str, dict[str, Any]] = {}


def _cache_get(key: str) -> str | None:
    """Return cached prompt text if the entry exists and is within TTL."""
    entry = _cache.get(key)
    if entry and (time.monotonic() - entry["ts"]) < _CACHE_TTL:
        return entry["text"]
    return None


def _cache_set(key: str, text: str) -> None:
    _cache[key] = {"text": text, "ts": time.monotonic()}


def _cache_clear() -> None:
    """Clear all cached entries — used in tests to ensure cache misses."""
    _cache.clear()


# ── Sync Langfuse fetch (runs in thread executor) ─────────────────────────────

def _fetch_prompt_sync(name: str, version: int | None, label: str | None) -> str:
    """Call langfuse.get_prompt() synchronously.

    The Langfuse Python SDK's get_prompt() is blocking; we always call it from
    asyncio.get_running_loop().run_in_executor() to avoid blocking the event loop.
    """
    try:
        lf = _lf_get_client()
    except Exception as exc:
        raise RuntimeError(f"Langfuse client could not be retrieved: {exc}") from exc

    if lf is None or not callable(getattr(lf, "get_prompt", None)):
        raise RuntimeError(
            "Langfuse client is not initialised or does not support get_prompt(). "
            "Check that LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set."
        )

    # version=None → Langfuse returns the latest version for the given label
    # label=None   → Langfuse defaults to "production" label
    prompt_obj = lf.get_prompt(
        name,
        version=version,
        label=label or "production",
    )
    # TextPromptClient.prompt → raw template string
    # ChatPromptClient.prompt → list[dict]; stringify for adapters
    raw = prompt_obj.prompt
    if isinstance(raw, list):
        # Convert chat prompt to a single user-turn string for text-mode adapters
        return "\n".join(
            f"[{m.get('role', '?')}] {m.get('content', '')}"
            for m in raw
            if isinstance(m, dict)
        )
    return str(raw)


# ── Public API ────────────────────────────────────────────────────────────────

async def resolve_prompts(spec: dict, org: "Org | None" = None) -> dict:
    """Inject Langfuse-managed prompt text into all llm_call nodes that have
    a prompt_ref field.

    When *org* is provided and the org has per-org Langfuse keys configured,
    those keys are used in preference to the global env vars.  This ensures
    each tenant's prompts are fetched from their own Langfuse project.

    Returns the spec unchanged in TESTING mode, when Langfuse is not configured,
    or when no llm_call nodes have a prompt_ref.  Always returns a new dict
    (deep copy) when any resolution is performed.
    """
    # Fast exits — no Langfuse calls needed.
    if os.getenv("TESTING") == "true":
        return spec

    # Determine effective Langfuse enablement — per-org keys take priority.
    if org is not None:
        from org_context import get_langfuse_keys as _get_lf_keys
        _pub, _sec = _get_lf_keys(org)
        _lf_active = bool(_pub)
    else:
        _lf_active = _LANGFUSE_ENABLED

    if not _lf_active:
        return spec

    nodes = spec.get("nodes", [])
    needs_resolve = any(
        n.get("type") == "llm_call" and n.get("prompt_ref", {}).get("name")
        for n in nodes
        if isinstance(n, dict)
    )
    if not needs_resolve:
        return spec   # fast path — nothing to resolve, no copy needed

    # Deep copy so we never mutate the caller's dict.
    spec = copy.deepcopy(spec)
    loop = asyncio.get_running_loop()

    for node in spec.get("nodes", []):
        if not isinstance(node, dict) or node.get("type") != "llm_call":
            continue
        ref = node.get("prompt_ref")
        if not isinstance(ref, dict) or not ref.get("name"):
            continue

        name:    str       = ref["name"]
        version: int | None = ref.get("version")     # None → latest
        label:   str | None = ref.get("label")        # None → "production"

        # Cache key includes org_id so two orgs with different Langfuse
        # projects but the same prompt name/version get independent entries.
        org_prefix = str(org.id) if org else "global"
        cache_key = f"{org_prefix}:{name}:{version or ''}:{label or ''}"
        cached_text = _cache_get(cache_key)

        if cached_text is not None:
            node["prompt_template"] = cached_text
            continue

        try:
            resolved = await loop.run_in_executor(
                None, _fetch_prompt_sync, name, version, label
            )
            _cache_set(cache_key, resolved)
            node["prompt_template"] = resolved
        except Exception as exc:
            print(
                f"[itsharness] WARNING: prompt_resolver — "
                f"could not resolve prompt '{name}' "
                f"(version={version or 'latest'}, label={label or 'production'}): {exc}",
                flush=True,
            )
            # Graceful fallback: leave prompt_template as-is.
            # The adapter will use its own default ("{{$.state.input}}") if empty.

    return spec
