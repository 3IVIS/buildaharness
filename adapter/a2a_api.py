"""
A2A (Agent-to-Agent) protocol endpoints.

Discovery (public — no auth):
  GET  /.well-known/agent/{flow_id}.json  → AgentCard for a deployed flow
  GET  /.well-known/agent.json            → AgentCard for the first/only deployment

Task API (JWT auth required):
  POST /a2a/{flow_id}/tasks/send          → create + start a task (returns Task object)
  GET  /a2a/{flow_id}/tasks/{task_id}     → task status + result
  GET  /a2a/{flow_id}/tasks/{task_id}/events → SSE stream of TaskStatusUpdateEvents

Deployment management (JWT auth required):
  POST   /deploy/a2a/{flow_id}            → deploy flow as A2A agent, upsert deployment row
  DELETE /deploy/a2a/{flow_id}            → undeploy, remove deployment row

The task state machine maps 1:1 onto the existing run job states:
  job queued  → A2A submitted
  job running → A2A working
  job done    → A2A completed
  job error   → A2A failed
  job paused  → A2A input-required

task_id == job_id (no separate persistence layer — wraps _jobs dict from run_api).
"""
import asyncio
import json as _json
import os
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.responses import StreamingResponse

from auth import current_user
from db import A2ADeployment, Flow, User, get_session
from rate_limit import limiter
from run_api import (
    _evict_stale_jobs,
    _jobs,
    _run_crewai,
    _run_langgraph,
)
from validate import validate_spec as _validate_spec
from prompt_resolver import resolve_prompts

# ── A2A state mapping ─────────────────────────────────────────────────────────

_A2A_STATE: dict[str, str] = {
    "queued":  "submitted",
    "running": "working",
    "done":    "completed",
    "error":   "failed",
    "paused":  "input-required",
}

# ── Base URL (used for endpoint_url construction) ─────────────────────────────

A2A_BASE_URL = os.getenv("A2A_BASE_URL", os.getenv("ADAPTER_BASE_URL", "http://localhost:8000"))

# ── Routers (three distinct URL namespaces) ───────────────────────────────────

router_well_known = APIRouter(tags=["a2a"])
router_tasks      = APIRouter(prefix="/a2a",        tags=["a2a"])
router_deploy     = APIRouter(prefix="/deploy/a2a", tags=["a2a"])

# ── Pydantic schemas ──────────────────────────────────────────────────────────

class A2AMessagePart(BaseModel):
    type: str = "text"
    text: str = ""

class A2AMessage(BaseModel):
    role:  str = "user"
    parts: list[A2AMessagePart] = []

class TaskSendRequest(BaseModel):
    id:      str = Field(..., min_length=1, description="Caller-supplied task ID (becomes job_id). Must be unique per adapter instance.")
    message: A2AMessage

class TaskStatus(BaseModel):
    state: str   # submitted | working | completed | failed | input-required

class TaskResponse(BaseModel):
    id:       str
    status:   TaskStatus
    flow_id:  str
    result:   str | None = None
    error:    str | None = None

class DeployResponse(BaseModel):
    flow_id:      str
    endpoint_url: str
    agent_card:   dict
    deployed_at:  datetime


# ── AgentCard generator (Python port of src/services/a2a.ts) ─────────────────

def generate_agent_card(
    flow_id:          str,
    flow_name:        str,
    flow_description: str | None,
    flow_config:      dict | None,
    base_url:         str = A2A_BASE_URL,
) -> dict | None:
    """Generate an A2A AgentCard from a flow's a2a_config.

    Returns None when a2a_config is absent or enabled is False.
    This is a faithful Python port of generateAgentCard() in a2a.ts.
    """
    a2a: dict = ((flow_config or {}).get("a2a_config") or {})
    if not a2a.get("enabled"):
        return None

    caps = set(a2a.get("capabilities") or [])

    return {
        "name":        a2a.get("agent_name")        or flow_name,
        "description": a2a.get("agent_description") or flow_description,
        # Discovery URL — external agents call this to fetch the full AgentCard.
        "url":         f"{base_url}/.well-known/agent/{flow_id}.json",
        "version":     a2a.get("version")           or "1.0.0",
        "capabilities": {
            "streaming":              "streaming"              in caps,
            "pushNotifications":      "pushNotifications"      in caps,
            "stateTransitionHistory": "stateTransitionHistory" in caps,
        },
        "authentication": {
            "schemes": [a2a.get("authentication") or "none"],
        },
        "defaultInputModes":  ["application/json"],
        "defaultOutputModes": ["application/json"],
        "skills": [
            {
                "id":          sk["id"],
                "name":        sk["name"],
                "description": sk.get("description"),
            }
            for sk in (a2a.get("skills") or [])
            if isinstance(sk, dict) and sk.get("id") and sk.get("name")
        ],
    }


# ── Shared helpers ────────────────────────────────────────────────────────────

async def _get_deployed_flow(
    flow_id: str,
    db:      AsyncSession,
) -> A2ADeployment:
    """Return the deployment record or raise 404."""
    record = (await db.execute(
        select(A2ADeployment).where(A2ADeployment.flow_id == flow_id)
    )).scalar_one_or_none()
    if not record:
        raise HTTPException(
            status_code=404,
            detail=f"No A2A deployment found for flow '{flow_id}'. "
                   "Call POST /deploy/a2a/{flow_id} first.",
        )
    return record


async def _get_flow_owned(
    flow_id: str,
    user:    User,
    db:      AsyncSession,
) -> Flow:
    """Return the flow or raise 404 (same message for missing and wrong owner)."""
    result = await db.execute(
        select(Flow).where(Flow.id == flow_id, Flow.user_id == user.id)
    )
    flow = result.scalar_one_or_none()
    if not flow:
        raise HTTPException(status_code=404, detail="Flow not found")
    return flow


def _task_response(job_id: str, flow_id: str) -> dict:
    """Build an A2A Task object from the current job state."""
    job = _jobs.get(job_id)
    if not job:
        return {
            "id":      job_id,
            "flow_id": flow_id,
            "status":  {"state": "failed"},
            "result":  None,
            "error":   "Task not found",
        }
    return {
        "id":      job_id,
        "flow_id": flow_id,
        "status":  {"state": _A2A_STATE.get(job["status"], "working")},
        "result":  job.get("result"),
        "error":   job.get("error"),
    }


# ── Well-known discovery routes (public — no auth) ────────────────────────────

@router_well_known.get("/.well-known/agent/{flow_id}.json", include_in_schema=True)
@limiter.limit("60/minute")
async def agent_card_for_flow(
    request: Request,
    flow_id: str,
    db:      AsyncSession = Depends(get_session),
) -> dict:
    """Return the A2A AgentCard for a specific deployed flow.

    No authentication required — this is the public discovery endpoint per the
    A2A specification.  External agents call this URL to learn the agent's name,
    capabilities, skills, and authentication requirements before sending tasks.
    """
    record = await _get_deployed_flow(flow_id, db)
    # Always return the snapshot taken at deploy time — stable even if the
    # flow spec has changed since.
    return record.agent_card


@router_well_known.get("/.well-known/agent.json", include_in_schema=True)
@limiter.limit("60/minute")
async def agent_card_default(
    request: Request,
    db: AsyncSession = Depends(get_session),
) -> dict | list:
    """Return the AgentCard for the single deployed flow, or a list if multiple exist.

    Convenience endpoint for single-flow deployments.  If multiple flows are
    deployed, returns an array of AgentCard objects so clients can discover all
    agents from one URL.
    """
    rows = (await db.execute(select(A2ADeployment))).scalars().all()
    if not rows:
        raise HTTPException(status_code=404, detail="No A2A agents deployed")
    if len(rows) == 1:
        return rows[0].agent_card
    return [r.agent_card for r in rows]


# ── Task routes ───────────────────────────────────────────────────────────────

@router_tasks.post("/{flow_id}/tasks/send", response_model=TaskResponse, status_code=202)
@limiter.limit("20/minute")
async def send_task(
    request:    Request,
    flow_id:    str,
    req:        TaskSendRequest,
    background: BackgroundTasks,
    user:       User          = Depends(current_user),
    db:         AsyncSession  = Depends(get_session),
) -> dict:
    """Create and start an A2A task for a flow.

    Maps the A2A TaskSendRequest onto the existing run job machinery — the task
    ID becomes the job ID so all existing status/events endpoints work without
    new persistence.

    The flow must exist, be owned by the caller, and have a2a_config.enabled=true.
    """
    flow = await _get_flow_owned(flow_id, user, db)
    spec = flow.current_spec or {}

    a2a_cfg = (spec.get("flow_config") or {}).get("a2a_config") or {}
    if not a2a_cfg.get("enabled"):
        raise HTTPException(
            status_code=400,
            detail=f"Flow '{flow_id}' does not have A2A enabled. "
                   "Set flow_config.a2a_config.enabled = true.",
        )

    _validate_spec(spec)
    spec = await resolve_prompts(spec)

    # Determine runtime — default to langgraph (same logic as run_api)
    runtime = (spec.get("runtime_hints") or {}).get("preferred_adapter", "langgraph")
    if runtime not in ("crewai", "langgraph"):
        runtime = "langgraph"

    _evict_stale_jobs()

    # task_id == job_id for 1:1 mapping
    job_id = req.id  # min_length=1 ensures this is always a non-empty string
    if job_id in _jobs:
        raise HTTPException(
            status_code=409,
            detail=f"Task '{job_id}' already exists. Use a unique task ID.",
        )

    _jobs[job_id] = dict(
        job_id=job_id,
        user_id=str(user.id),
        status="queued",
        runtime=runtime,
        started_at=datetime.now(UTC),
        ended_at=None, result=None, error=None,
        node_events=[], hitl_state=None,
        trace_id=None, trace_url=None,
        compiled_graph=None, lg_config=None, trackable=[],
        # A2A metadata stored alongside job for reference
        a2a_flow_id=flow_id,
        a2a_message=req.message.model_dump(),
    )

    if runtime == "langgraph":
        background.add_task(_run_langgraph, job_id, spec)
    else:
        background.add_task(_run_crewai, job_id, spec)

    return _task_response(job_id, flow_id)


@router_tasks.get("/{flow_id}/tasks/{task_id}", response_model=TaskResponse)
async def get_task(
    flow_id: str,
    task_id: str,
    user:    User         = Depends(current_user),
    db:      AsyncSession = Depends(get_session),
) -> dict:
    """Return current task status.

    GET /a2a/{flow_id}/tasks/{task_id} maps directly to GET /run/{job_id}
    with A2A state translation.  The flow_id parameter is validated to ensure
    the task belongs to this flow.
    """
    # Verify flow ownership (prevents leaking task existence for other users)
    await _get_flow_owned(flow_id, user, db)

    job = _jobs.get(task_id)
    if not job or job.get("user_id") != str(user.id):
        raise HTTPException(status_code=404, detail="Task not found")
    if job.get("a2a_flow_id") and job["a2a_flow_id"] != flow_id:
        raise HTTPException(status_code=404, detail="Task not found")

    return _task_response(task_id, flow_id)


@router_tasks.get("/{flow_id}/tasks/{task_id}/events")
async def task_events_stream(
    flow_id: str,
    task_id: str,
    user:    User         = Depends(current_user),
    db:      AsyncSession = Depends(get_session),
):
    """Server-Sent Events stream for real-time task status updates.

    Reuses the existing node_events structure from run_api.py — each entry is
    wrapped in an A2A TaskStatusUpdateEvent and streamed to the client as it
    appears.  The stream terminates when the task reaches a terminal state
    (completed or failed).

    Clients receive:
      - A TaskStatusUpdateEvent for every new node_event
      - A final TaskStatusUpdateEvent when the job reaches done/error
    """
    await _get_flow_owned(flow_id, user, db)

    job = _jobs.get(task_id)
    if not job or job.get("user_id") != str(user.id):
        raise HTTPException(status_code=404, detail="Task not found")

    async def _generate():
        sent = 0
        while True:
            j = _jobs.get(task_id)
            if not j:
                # Job was evicted (TTL cleanup) while client was still streaming.
                # Send an explicit failed terminal event so the client doesn't hang.
                final = _json.dumps({
                    "type":   "TaskStatusUpdateEvent",
                    "id":     task_id,
                    "status": {"state": "failed"},
                    "final":  True,
                    "error":  "Task record expired or was evicted",
                })
                yield f"data: {final}\n\n"
                break

            events = j.get("node_events", [])
            new_events = events[sent:]
            sent += len(new_events)

            for ev in new_events:
                payload = _json.dumps({
                    "type":       "TaskStatusUpdateEvent",
                    "id":         task_id,
                    "status":     {"state": _A2A_STATE.get(j["status"], "working")},
                    "nodeEvent":  ev,
                    "final":      False,
                })
                yield f"data: {payload}\n\n"

            current_state = _A2A_STATE.get(j["status"], "working")

            if j["status"] in ("done", "error"):
                # Send final event and close stream
                final = _json.dumps({
                    "type":   "TaskStatusUpdateEvent",
                    "id":     task_id,
                    "status": {"state": current_state},
                    "final":  True,
                    "result": j.get("result"),
                    "error":  j.get("error"),
                })
                yield f"data: {final}\n\n"
                break

            await asyncio.sleep(0.8)

    return StreamingResponse(
        _generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control":    "no-cache",
            "X-Accel-Buffering": "no",   # disable nginx buffering
            "Connection":       "keep-alive",
        },
    )


# ── Deployment management routes ──────────────────────────────────────────────

@router_deploy.post("/{flow_id}", response_model=DeployResponse, status_code=200)
async def deploy_flow(
    flow_id: str,
    user:    User         = Depends(current_user),
    db:      AsyncSession = Depends(get_session),
) -> DeployResponse:
    """Deploy a flow as an A2A agent.

    Creates or updates an a2a_deployments row for this flow.  Snapshots the
    AgentCard at deploy time so the /.well-known/agent.json endpoint returns a
    stable card even if the flow spec is later modified.

    Sets endpoint_url to {A2A_BASE_URL}/a2a/{flow_id}/tasks/send.
    The canvas Deploy button writes endpoint_url back into a2a_config so the
    Config tab renders it as a read-only field.

    Requires: flow exists, caller owns it, a2a_config.enabled = true.
    """
    flow = await _get_flow_owned(flow_id, user, db)
    spec = flow.current_spec or {}

    a2a_cfg = (spec.get("flow_config") or {}).get("a2a_config") or {}
    if not a2a_cfg.get("enabled"):
        raise HTTPException(
            status_code=400,
            detail=f"Flow '{flow_id}' does not have A2A enabled. "
                   "Set flow_config.a2a_config.enabled = true in Flow Settings → Config.",
        )

    endpoint_url = f"{A2A_BASE_URL}/a2a/{flow_id}/tasks/send"

    card = generate_agent_card(
        flow_id=flow_id,
        flow_name=flow.name,
        flow_description=spec.get("description"),
        flow_config=spec.get("flow_config"),
        base_url=A2A_BASE_URL,
    )
    if card is None:
        raise HTTPException(
            status_code=400,
            detail="AgentCard generation failed — check a2a_config fields.",
        )

    # Upsert: update if deployment already exists, insert if not.
    # We already verified flow ownership above via _get_flow_owned, so the
    # deployment record's user_id must match the current caller too.
    existing = (await db.execute(
        select(A2ADeployment).where(A2ADeployment.flow_id == flow_id)
    )).scalar_one_or_none()

    now = datetime.now(UTC)

    if existing:
        # Ownership guard: the deployment should belong to the same user as the flow.
        if str(existing.user_id) != str(user.id):
            raise HTTPException(
                status_code=403,
                detail="A deployment for this flow already exists and belongs to a different user.",
            )
        existing.endpoint_url = endpoint_url
        existing.agent_card   = card
        existing.deployed_at  = now
        record = existing
    else:
        record = A2ADeployment(
            id=uuid.uuid4(),
            flow_id=flow_id,
            user_id=user.id,
            endpoint_url=endpoint_url,
            agent_card=card,
            deployed_at=now,
        )
        db.add(record)

    await db.commit()

    return DeployResponse(
        flow_id=flow_id,
        endpoint_url=endpoint_url,
        agent_card=card,
        deployed_at=now,
    )


@router_deploy.delete("/{flow_id}", status_code=204)
async def undeploy_flow(
    flow_id: str,
    user:    User         = Depends(current_user),
    db:      AsyncSession = Depends(get_session),
) -> None:
    """Remove the A2A deployment for a flow.

    Deletes the a2a_deployments row.  After this, /.well-known/agent/{flow_id}.json
    returns 404 and POST /a2a/{flow_id}/tasks/send still works (tasks are
    independent of deployment records) but the agent is no longer publicly
    discoverable.
    """
    # Verify ownership of the flow (not just the deployment)
    await _get_flow_owned(flow_id, user, db)

    record = (await db.execute(
        select(A2ADeployment).where(A2ADeployment.flow_id == flow_id)
    )).scalar_one_or_none()

    if not record:
        # Idempotent — undeploying an already-undeployed flow is fine
        return

    if str(record.user_id) != str(user.id):
        raise HTTPException(status_code=403, detail="Not your deployment")

    await db.delete(record)
    await db.commit()
