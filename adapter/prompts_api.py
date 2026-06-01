"""
Prompt versioning — Langfuse Prompt Management API proxy.

GET /prompts            → list all prompt names (for the canvas PromptPicker dropdown)
GET /prompts/{name}     → versions + full content for a specific prompt (for preview)

Both endpoints proxy the Langfuse HTTP API and require auth.
The Langfuse secret key is NEVER forwarded to the frontend — only the
processed data (name, versions, truncated preview) crosses the API boundary.

Multi-tenant: both endpoints accept the active org via OrgDep and use per-org
Langfuse keys when configured, falling back to the global env-var keys.
This ensures each org's PromptPicker shows prompts from their own Langfuse
project rather than the shared global project.

TESTING=true / Langfuse absent → stub responses, no network calls.
"""

import os

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from auth import current_user
from db import User
from org_context import Org, OrgDep, get_langfuse_keys

_LANGFUSE_BASE_URL = os.getenv("LANGFUSE_BASE_URL", "http://langfuse:3000")
_LANGFUSE_ENABLED = bool(os.getenv("LANGFUSE_PUBLIC_KEY"))

router = APIRouter(prefix="/prompts", tags=["prompts"])


# ── Pydantic response schemas ─────────────────────────────────────────────────


class PromptSummary(BaseModel):
    name: str
    version: int
    labels: list[str] = []


class PromptDetail(BaseModel):
    name: str
    version: int
    prompt: str  # raw template text (first 2000 chars for preview)
    labels: list[str] = []
    versions: list[int] = []  # all available version numbers


# ── HTTP client ───────────────────────────────────────────────────────────────


def _lf_http(org: Org | None = None) -> httpx.AsyncClient:
    """Authenticated async httpx client for the Langfuse HTTP API.

    Uses per-org keys when the org has both configured (same logic as eval_api),
    otherwise falls back to the global LANGFUSE_* env vars.
    """
    pub, sec = get_langfuse_keys(org)
    return httpx.AsyncClient(
        base_url=_LANGFUSE_BASE_URL,
        auth=(pub, sec),
        timeout=8.0,
    )


def _is_langfuse_active(org: Org | None) -> bool:
    """Return True if Langfuse is available for this org."""
    pub, _ = get_langfuse_keys(org)
    return bool(pub)


# ── Routes ────────────────────────────────────────────────────────────────────


@router.get("", response_model=list[PromptSummary])
async def list_prompts(
    org: OrgDep,
    limit: int = Query(default=50, ge=1, le=100),
    user: User = Depends(current_user),
) -> list[PromptSummary]:
    """Return all prompt names registered in Langfuse for the active org.

    Used by the canvas PromptPicker dropdown to populate the prompt selector.
    Returns an empty list when Langfuse is not configured — the canvas falls
    back to inline mode gracefully.
    """
    if os.getenv("TESTING") == "true" or not _is_langfuse_active(org):
        return []

    async with _lf_http(org) as http:
        try:
            # Langfuse v3 moved the list endpoint to /api/public/v2/prompts.
            # /api/public/prompts without a ?name= param returns 400 in v3.
            resp = await http.get("/api/public/v2/prompts", params={"limit": limit})
            resp.raise_for_status()
            data = resp.json()
        except httpx.HTTPStatusError as exc:
            raise HTTPException(
                status_code=exc.response.status_code,
                detail=f"Langfuse API error: {exc.response.text}",
            ) from exc
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Langfuse unreachable: {exc}") from exc

    result: list[PromptSummary] = []
    for item in data.get("data", []):
        if not isinstance(item, dict) or not item.get("name"):
            continue
        # v2 response has "versions": [1, 2, ...] instead of "version": N.
        versions_list: list[int] = item.get("versions") or []
        latest_version: int = max(versions_list) if versions_list else 1
        result.append(
            PromptSummary(
                name=item["name"],
                version=item.get("version") or latest_version,
                labels=item.get("labels", []),
            )
        )
    return result


@router.get("/{name}", response_model=PromptDetail)
async def get_prompt(
    name: str,
    org: OrgDep,
    user: User = Depends(current_user),
) -> PromptDetail:
    """Return the latest version and full content of a named prompt.

    Used by the canvas config panel to preview prompt content before pinning
    to a specific version.  The prompt text is truncated to 2000 chars for
    the preview; the full text is resolved at runtime by prompt_resolver.py.

    Uses per-org Langfuse keys when configured on the org, so each tenant's
    canvas shows prompts from their own project.
    """
    if os.getenv("TESTING") == "true" or not _is_langfuse_active(org):
        raise HTTPException(
            status_code=404,
            detail=f"Prompt '{name}' not found (Langfuse not configured in this environment)",
        )

    async with _lf_http(org) as http:
        try:
            # Langfuse v3: path param /api/public/prompts/{name} was removed;
            # use ?name= query param on /api/public/prompts instead.
            resp = await http.get("/api/public/prompts", params={"name": name})
            resp.raise_for_status()
            data = resp.json()
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 404:
                raise HTTPException(status_code=404, detail=f"Prompt '{name}' not found in Langfuse") from exc
            raise HTTPException(
                status_code=exc.response.status_code,
                detail=f"Langfuse API error: {exc.response.text}",
            ) from exc
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Langfuse unreachable: {exc}") from exc

    # Extract prompt text — Langfuse returns either a string (text prompt)
    # or a list of message dicts (chat prompt).  For preview, stringify both.
    raw_prompt = data.get("prompt", "")
    if isinstance(raw_prompt, list):
        preview_text = "\n".join(
            f"[{m.get('role', '?')}] {m.get('content', '')}" for m in raw_prompt if isinstance(m, dict)
        )
    else:
        preview_text = str(raw_prompt)

    versions_list: list[int] = []
    raw_versions = data.get("versions", [])
    if isinstance(raw_versions, list):
        versions_list = [v for v in raw_versions if isinstance(v, int)]

    return PromptDetail(
        name=data.get("name", name),
        version=data.get("version", 1),
        prompt=preview_text[:2000],
        labels=data.get("labels", []),
        versions=versions_list,
    )
