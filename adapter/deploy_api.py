"""
Unified one-click deployment.

One POST call deploys a flow as all three targets simultaneously:
  REST endpoint  — synchronous HTTP invocation
  MCP tool       — Model Context Protocol discovery + tool manifest
  A2A agent      — Agent-to-Agent protocol (when a2a_config.enabled)

Routes
──────
  POST /deploy/{flow_id}
      Deploy (or re-deploy) a flow.  Upserts unified_deployments.  When the
      flow has a2a_config.enabled=true, also upserts a2a_deployments so the
      existing A2A panel / AgentCard endpoints keep working.

  DELETE /deploy/{flow_id}
      Remove the unified deployment.  Also removes the A2A deployment row.

  GET /.well-known/mcp/{flow_id}.json    (public — no auth)
      MCP tool manifest for the deployed flow.

  GET /share/{flow_id}                   (public — no auth)
      Human-readable deployment metadata for the shareable URL.

  POST /flows/{flow_id}/invoke           (JWT auth required)
      Synchronous REST execution.  Runs the flow inline and returns the
      result when it finishes (or 504 on timeout, 422 on HITL pause).
"""
import asyncio
import os
import re
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from auth import current_user
from db import (
    A2ADeployment,
    Flow,
    UnifiedDeployment,
    User,
    get_session,
)
from org_context import Org, current_org as _current_org
from rate_limit import limiter
from run_api import (
    _evict_stale_jobs,
    _job_session,
    _jobs_create,
    _jobs_get,
    _run_crewai,
    _run_langgraph,
    _run_mastra,
)
from validate import validate_spec as _validate_spec
from prompt_resolver import resolve_prompts
from a2a_api import generate_agent_card, A2A_BASE_URL

# ── Base URL ─────────────────────────────────────────────────────────────────

# Strip any trailing slash so generated URLs like f"{ADAPTER_BASE_URL}/flows/..."
# don't produce double slashes if the env var was set with a trailing slash.
ADAPTER_BASE_URL = os.getenv("ADAPTER_BASE_URL", "http://localhost:8000").rstrip("/")

# Synchronous invoke timeout in seconds (override via INVOKE_TIMEOUT_S env var).
INVOKE_TIMEOUT_S = int(os.getenv("INVOKE_TIMEOUT_S", "120"))

# ── Routers ───────────────────────────────────────────────────────────────────

router_deploy      = APIRouter(prefix="/deploy",   tags=["deploy"])
router_well_known  = APIRouter(tags=["deploy"])
router_share       = APIRouter(tags=["deploy"])
router_invoke      = APIRouter(prefix="/flows",    tags=["deploy"])

# ── Python → JSON Schema type map ────────────────────────────────────────────

_PY_TYPE_MAP: dict[str, str] = {
    "str":   "string",
    "int":   "integer",
    "float": "number",
    "bool":  "boolean",
    "list":  "array",
    "dict":  "object",
    "Any":   "string",
    "None":  "null",
}


def _py_to_json_schema_type(py_type: str) -> str:
    """Map a Python type annotation string to a JSON Schema type string."""
    base = py_type.split("[")[0].strip()
    return _PY_TYPE_MAP.get(base, "string")


# ── MCP manifest generator ───────────────────────────────────────────────────

def generate_mcp_manifest(
    flow_id:          str,
    flow_name:        str,
    flow_description: str | None,
    spec:             dict,
    base_url:         str = ADAPTER_BASE_URL,
) -> dict:
    """Build an MCP tool manifest from a FlowSpec.

    The manifest follows the MCP tool-list format so any MCP-compatible
    client (Claude Desktop, custom integrations) can discover and call the
    flow as a named tool.

    Input schema is derived from state_schema.fields — each field becomes a
    JSON Schema property.  Fields with reducer=append are typed as arrays.
    """
    state_schema = spec.get("state_schema") or {}
    fields:       list[dict] = state_schema.get("fields") or []

    properties: dict[str, Any] = {}
    required:   list[str]      = []

    for field in fields:
        name    = field.get("name")
        ftype   = field.get("type", "str")
        reducer = field.get("reducer", "replace")
        if not name:
            continue

        if reducer == "append":
            prop: dict[str, Any] = {
                "type":        "array",
                "items":       {"type": _py_to_json_schema_type(ftype)},
                "description": f"Append-reducer list field: {name}",
            }
        else:
            prop = {
                "type":        _py_to_json_schema_type(ftype),
                "description": f"Flow state field: {name}",
            }

        properties[name] = prop
        # Only mark as required if the field is not a list reducer
        # (list reducers are typically accumulator outputs, not inputs).
        if reducer != "append":
            required.append(name)

    # Sanitise tool name: MCP requires [a-z0-9_] slug.
    # Apply the same sanitisation to the flow_id fallback so hyphens are
    # replaced with underscores (flow IDs are kebab-case, MCP names cannot be).
    tool_name = re.sub(r"[^a-zA-Z0-9]+", "_", flow_name).lower().strip("_") \
                or re.sub(r"[^a-zA-Z0-9]+", "_", flow_id).lower().strip("_") \
                or "flow"

    input_schema: dict[str, Any] = {
        "type":       "object",
        "properties": properties,
    }
    if required:
        input_schema["required"] = required

    return {
        "schema_version": "v1",
        "tools": [
            {
                "name":        tool_name,
                "description": flow_description or f"Execute the '{flow_name}' flow",
                "inputSchema": input_schema,
                "endpoint":    f"{base_url}/flows/{flow_id}/invoke",
            }
        ],
    }


# ── Pydantic schemas ──────────────────────────────────────────────────────────

class UnifiedDeployResponse(BaseModel):
    flow_id:       str
    rest_url:      str
    mcp_url:       str
    a2a_url:       str | None
    shareable_url: str
    mcp_manifest:  dict
    deployed_at:   datetime


class ShareResponse(BaseModel):
    flow_id:       str
    flow_name:     str
    rest_url:      str
    mcp_url:       str
    a2a_url:       str | None
    shareable_url: str
    deployed_at:   datetime


class InvokeRequest(BaseModel):
    input: dict = {}


class InvokeResponse(BaseModel):
    job_id:  str
    output:  Any
    runtime: str


# ── Shared helpers ────────────────────────────────────────────────────────────

async def _get_unified_deployment(
    flow_id: str,
    db:      AsyncSession,
) -> UnifiedDeployment:
    record = (await db.execute(
        select(UnifiedDeployment).where(UnifiedDeployment.flow_id == flow_id)
    )).scalar_one_or_none()
    if not record:
        raise HTTPException(
            status_code=404,
            detail=f"No unified deployment found for flow '{flow_id}'. "
                   "Call POST /deploy/{flow_id} first.",
        )
    return record


async def _get_flow_owned(
    flow_id: str,
    user:    User,
    db:      AsyncSession,
) -> Flow:
    result = await db.execute(
        select(Flow).where(Flow.id == flow_id, Flow.user_id == user.id)
    )
    flow = result.scalar_one_or_none()
    if not flow:
        raise HTTPException(status_code=404, detail="Flow not found")
    return flow


# ── Deploy management ─────────────────────────────────────────────────────────

@router_deploy.post("/{flow_id}", response_model=UnifiedDeployResponse, status_code=200)
@limiter.limit("20/minute")
async def unified_deploy(
    request: Request,
    flow_id: str,
    user:    User         = Depends(current_user),
    db:      AsyncSession = Depends(get_session),
    org:     "Org"        = Depends(_current_org),
) -> UnifiedDeployResponse:
    """Deploy a flow as a REST endpoint + MCP tool + A2A agent in one call.

    Upserts unified_deployments with URL snapshots and an MCP manifest generated
    from the flow's state_schema.  When a2a_config.enabled=true, also upserts
    a2a_deployments so /.well-known/agent/{flow_id}.json keeps working.

    Idempotent — re-deploying updates the snapshot to the current spec.
    """
    flow = await _get_flow_owned(flow_id, user, db)
    spec = flow.current_spec or {}

    # Validate spec before snapshotting.
    _validate_spec(spec)

    now          = datetime.now(UTC)
    rest_url     = f"{ADAPTER_BASE_URL}/flows/{flow_id}/invoke"
    mcp_url      = f"{ADAPTER_BASE_URL}/.well-known/mcp/{flow_id}.json"
    shareable_url = f"{ADAPTER_BASE_URL}/share/{flow_id}"

    mcp_manifest = generate_mcp_manifest(
        flow_id=flow_id,
        flow_name=flow.name,
        flow_description=spec.get("description"),
        spec=spec,
        base_url=ADAPTER_BASE_URL,
    )

    # A2A URL only when a2a_config.enabled is true.
    a2a_cfg = (spec.get("flow_config") or {}).get("a2a_config") or {}
    a2a_url: str | None = None
    if a2a_cfg.get("enabled"):
        a2a_url = f"{A2A_BASE_URL}/a2a/{flow_id}/tasks/send"

    org_id = org.id if org else None

    # ── Upsert unified_deployments ────────────────────────────────────────────
    existing = (await db.execute(
        select(UnifiedDeployment).where(UnifiedDeployment.flow_id == flow_id)
    )).scalar_one_or_none()

    if existing:
        if str(existing.user_id) != str(user.id):
            raise HTTPException(
                status_code=403,
                detail="A deployment for this flow already exists and belongs to a different user.",
            )
        existing.rest_url      = rest_url
        existing.mcp_url       = mcp_url
        existing.a2a_url       = a2a_url
        existing.shareable_url = shareable_url
        existing.mcp_manifest  = mcp_manifest
        existing.deployed_at   = now
        record = existing
    else:
        record = UnifiedDeployment(
            id=uuid.uuid4(),
            flow_id=flow_id,
            user_id=user.id,
            org_id=org_id,
            rest_url=rest_url,
            mcp_url=mcp_url,
            a2a_url=a2a_url,
            shareable_url=shareable_url,
            mcp_manifest=mcp_manifest,
            deployed_at=now,
        )
        db.add(record)

    # ── Upsert a2a_deployments when A2A is enabled ────────────────────────────
    if a2a_url:
        card = generate_agent_card(
            flow_id=flow_id,
            flow_name=flow.name,
            flow_description=spec.get("description"),
            flow_config=spec.get("flow_config"),
            base_url=A2A_BASE_URL,
        )
        if card:
            a2a_existing = (await db.execute(
                select(A2ADeployment).where(A2ADeployment.flow_id == flow_id)
            )).scalar_one_or_none()

            if a2a_existing:
                a2a_existing.endpoint_url = a2a_url
                a2a_existing.agent_card   = card
                a2a_existing.deployed_at  = now
            else:
                db.add(A2ADeployment(
                    id=uuid.uuid4(),
                    flow_id=flow_id,
                    user_id=user.id,
                    org_id=org_id,
                    endpoint_url=a2a_url,
                    agent_card=card,
                    deployed_at=now,
                ))

    # Protect against the rare race where two simultaneous deploys both read
    # existing=None and both attempt INSERT — the second will hit the UNIQUE
    # constraint on flow_id.  Catch IntegrityError and re-read the winner's row
    # so both callers get a valid 200 response.
    try:
        await db.commit()
    except Exception as exc:
        if "unique" in str(exc).lower() or "integrity" in str(exc).lower():
            await db.rollback()
            # Re-read whatever the concurrent winner inserted
            winner = (await db.execute(
                select(UnifiedDeployment).where(UnifiedDeployment.flow_id == flow_id)
            )).scalar_one_or_none()
            if winner:
                return UnifiedDeployResponse(
                    flow_id=winner.flow_id,
                    rest_url=winner.rest_url,
                    mcp_url=winner.mcp_url,
                    a2a_url=winner.a2a_url,
                    shareable_url=winner.shareable_url,
                    mcp_manifest=winner.mcp_manifest,
                    deployed_at=winner.deployed_at,
                )
        raise

    return UnifiedDeployResponse(
        flow_id=flow_id,
        rest_url=rest_url,
        mcp_url=mcp_url,
        a2a_url=a2a_url,
        shareable_url=shareable_url,
        mcp_manifest=mcp_manifest,
        deployed_at=now,
    )


@router_deploy.delete("/{flow_id}", status_code=204)
@limiter.limit("20/minute")
async def unified_undeploy(
    request: Request,
    flow_id: str,
    user:    User         = Depends(current_user),
    db:      AsyncSession = Depends(get_session),
) -> None:
    """Remove the unified deployment for a flow.

    Deletes the unified_deployments row and, if present, the a2a_deployments
    row.  Idempotent — undeploying a non-deployed flow returns 204.
    """
    await _get_flow_owned(flow_id, user, db)

    unified = (await db.execute(
        select(UnifiedDeployment).where(UnifiedDeployment.flow_id == flow_id)
    )).scalar_one_or_none()

    if unified:
        if str(unified.user_id) != str(user.id):
            raise HTTPException(status_code=403, detail="Not your deployment")
        await db.delete(unified)

    # Also remove A2A deployment so /.well-known/agent/ returns 404.
    a2a = (await db.execute(
        select(A2ADeployment).where(A2ADeployment.flow_id == flow_id)
    )).scalar_one_or_none()

    if a2a and str(a2a.user_id) == str(user.id):
        await db.delete(a2a)

    await db.commit()


# ── MCP discovery (public) ────────────────────────────────────────────────────

@router_well_known.get("/.well-known/mcp/{flow_id}.json", include_in_schema=True)
@limiter.limit("60/minute")
async def mcp_manifest_for_flow(
    request: Request,
    flow_id: str,
    db:      AsyncSession = Depends(get_session),
) -> dict:
    """Return the MCP tool manifest for a deployed flow.

    No authentication required — this is the public MCP discovery endpoint.
    Claude Desktop and other MCP clients fetch this URL to learn the tool
    name, description, and input schema before calling the flow.

    Returns the snapshot taken at deploy time so the manifest is stable even
    if the flow spec has changed since deployment.
    """
    record = await _get_unified_deployment(flow_id, db)
    return record.mcp_manifest


# ── Shareable URL (public) ────────────────────────────────────────────────────

@router_share.get("/share/{flow_id}", response_model=ShareResponse)
@limiter.limit("60/minute")
async def share_page(
    request: Request,
    flow_id: str,
    db:      AsyncSession = Depends(get_session),
) -> ShareResponse:
    """Return deployment metadata for the shareable URL.

    No authentication required.  Returns the flow name and all endpoint URLs
    so a recipient of the share link knows how to interact with the flow.
    """
    record = await _get_unified_deployment(flow_id, db)

    # Flow name — fetch from flows table (may be public info via the share link).
    flow_result = await db.execute(select(Flow).where(Flow.id == flow_id))
    flow        = flow_result.scalar_one_or_none()
    flow_name   = flow.name if flow else flow_id

    return ShareResponse(
        flow_id=flow_id,
        flow_name=flow_name,
        rest_url=record.rest_url,
        mcp_url=record.mcp_url,
        a2a_url=record.a2a_url,
        shareable_url=record.shareable_url,
        deployed_at=record.deployed_at,
    )


# ── REST invocation ────────────────────────────────────────────────────────────

@router_invoke.post("/{flow_id}/invoke", response_model=InvokeResponse)
@limiter.limit("10/minute")
async def invoke_flow(
    request: Request,
    flow_id: str,
    req:     InvokeRequest,
    user:    User          = Depends(current_user),
    db:      AsyncSession  = Depends(get_session),
    org:     "Org"         = Depends(_current_org),
) -> InvokeResponse:
    """Synchronously execute a deployed flow and return the result.

    Validates that a unified deployment exists (i.e. the flow has been
    explicitly deployed via POST /deploy/{flow_id}), then runs the flow
    inline and waits up to INVOKE_TIMEOUT_S seconds for it to finish.

    Returns 504 on timeout, 422 if the flow pauses on a HITL node (use the
    A2A or /run endpoints for interactive flows), 502 on runner error.

    The req.input dict is merged into the flow's initial state before
    execution so callers can provide dynamic inputs without editing the spec.
    """
    # Verify a deployment exists (gives a clear "deploy first" error if not).
    await _get_unified_deployment(flow_id, db)

    flow = await _get_flow_owned(flow_id, user, db)
    spec = flow.current_spec or {}

    _validate_spec(spec)
    spec = await resolve_prompts(spec, org)

    # Merge caller-supplied input into the spec's initial_inputs so the flow
    # receives dynamic values without spec mutation.
    if req.input:
        existing_inputs: dict = (spec.get("flow_config") or {}).get("initial_inputs") or {}
        merged = {**existing_inputs, **req.input}
        spec = {
            **spec,
            "flow_config": {**(spec.get("flow_config") or {}), "initial_inputs": merged},
        }

    runtime = (spec.get("runtime_hints") or {}).get("preferred_adapter", "langgraph")
    if runtime not in ("crewai", "langgraph", "mastra"):
        runtime = "langgraph"

    await _evict_stale_jobs(db)

    job_id = str(uuid.uuid4())
    org_id = str(org.id) if org else None
    await _jobs_create(job_id, str(user.id), runtime, db, org_id=org_id)

    # Run synchronously with a hard timeout.  The runners use _job_session()
    # internally so they don't interfere with the request session.
    runner = {
        "langgraph": _run_langgraph,
        "crewai":    _run_crewai,
        "mastra":    _run_mastra,
    }[runtime]

    try:
        await asyncio.wait_for(runner(job_id, spec, org_id), timeout=INVOKE_TIMEOUT_S)
    except asyncio.TimeoutError:
        # The runner coroutine was cancelled — mark the job as failed so it
        # doesn't stay in "running" state until TTL eviction.
        try:
            async with _job_session() as _db:
                _timeout_job = await _jobs_get(job_id, _db)
                if _timeout_job and _timeout_job.status not in ("done", "error", "paused"):
                    _timeout_job.status   = "error"
                    _timeout_job.error    = f"Invocation timed out after {INVOKE_TIMEOUT_S}s"
                    _timeout_job.ended_at = datetime.now(UTC)
                    await _db.commit()
        except Exception:
            pass  # best-effort — don't mask the original timeout response
        raise HTTPException(
            status_code=504,
            detail=f"Flow execution timed out after {INVOKE_TIMEOUT_S}s. "
                   "Use POST /run for long-running flows and poll GET /run/{job_id}.",
        )

    # Fetch final job state via a fresh background session to bypass the
    # request session's identity map (the runner wrote via its own sessions).
    async with _job_session() as bg_db:
        job = await _jobs_get(job_id, bg_db)

    if not job:
        raise HTTPException(status_code=500, detail="Job record not found after execution.")

    if job.status == "paused":
        raise HTTPException(
            status_code=422,
            detail="Flow paused waiting for human input. "
                   "Use POST /run + POST /run/{job_id}/resume for HITL flows.",
        )

    if job.status == "error":
        raise HTTPException(status_code=502, detail=job.error or "Flow execution failed.")

    return InvokeResponse(
        job_id=job_id,
        output=job.result,
        runtime=runtime,
    )
