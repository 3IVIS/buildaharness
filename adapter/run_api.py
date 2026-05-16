"""
Flow execution endpoint.

POST /run?runtime=crewai  → compile + execute (async job), returns {job_id}
GET  /run/{job_id}        → job status + result + node_events stream
"""
import asyncio
import uuid
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel

from db import User
from auth import current_user
from crewai_adapter import compile_crewai, safe_id

router = APIRouter(prefix="/run", tags=["run"])

# In-memory job store — Phase 2 moves this to Postgres
_jobs: dict[str, dict[str, Any]] = {}

JobStatus = Literal["queued", "running", "done", "error"]


class RunRequest(BaseModel):
    spec: dict

class NodeEvent(BaseModel):
    node_id: str
    status:  Literal["pending", "running", "done", "error"]
    ts:      str
    ms:      int | None = None

class JobStatusResponse(BaseModel):
    job_id:      str
    status:      JobStatus
    runtime:     str
    started_at:  datetime
    ended_at:    datetime | None = None
    result:      str | None = None
    error:       str | None = None
    node_events: list[dict]   = []


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

def _emit(job_id: str, node_id: str, status: str, ms: int | None = None):
    _jobs[job_id]["node_events"].append(
        {"node_id": node_id, "status": status, "ts": _now_iso(), "ms": ms}
    )


async def _run_crewai(job_id: str, spec: dict):
    _jobs[job_id].update(status="running", started_at=datetime.now(timezone.utc))
    try:
        code, warnings = compile_crewai(spec)

        namespace: dict = {}
        exec(compile(code, "<crewai_generated>", "exec"), namespace)  # noqa: S102

        crew = namespace.get("crew")
        if crew is None:
            raise RuntimeError("Generated code did not produce a 'crew' variable")

        # ── Map task objects → node IDs ────────────────────────────────────
        # task variables in generated code are named task_{safe_id(node_id)}
        obj_id_to_node: dict[int, str] = {}
        for node in spec.get("nodes", []):
            nid  = node["id"]
            var  = f"task_{safe_id(nid)}"
            if var in namespace:
                obj_id_to_node[id(namespace[var])] = nid

        # Execution order comes from crew.tasks (already topologically sorted)
        task_sequence: list[str] = [
            obj_id_to_node[id(t)]
            for t in crew.tasks
            if id(t) in obj_id_to_node
        ]

        # Nodes with no task mapping (annotation, group, etc.) are ignored
        untracked = [
            n["id"] for n in spec.get("nodes", [])
            if n["id"] not in task_sequence
            and n.get("type") not in {"input", "output", "annotation"}
        ]

        # ── Emit initial state ─────────────────────────────────────────────
        for i, nid in enumerate(task_sequence):
            _emit(job_id, nid, "running" if i == 0 else "pending")

        # ── Per-task timing ────────────────────────────────────────────────
        task_start: dict[str, datetime] = {}
        if task_sequence:
            task_start[task_sequence[0]] = datetime.now(timezone.utc)

        # ── Inject callbacks ───────────────────────────────────────────────
        for i, task in enumerate(crew.tasks):
            nid      = obj_id_to_node.get(id(task))
            if nid is None:
                continue
            next_nid = task_sequence[i + 1] if i + 1 < len(task_sequence) else None

            def make_cb(node_id: str, next_node_id: str | None):
                def cb(_task_output):
                    elapsed = None
                    if node_id in task_start:
                        elapsed = int(
                            (datetime.now(timezone.utc) - task_start[node_id])
                            .total_seconds() * 1000
                        )
                    _emit(job_id, node_id, "done", elapsed)
                    if next_node_id:
                        task_start[next_node_id] = datetime.now(timezone.utc)
                        _emit(job_id, next_node_id, "running")
                return cb

            task.callback = make_cb(nid, next_nid)

        # ── Execute ───────────────────────────────────────────────────────
        loop   = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, crew.kickoff)

        # Mark any task-tracked nodes that didn't fire their callback (edge case)
        seen_done = {e["node_id"] for e in _jobs[job_id]["node_events"] if e["status"] == "done"}
        for nid in task_sequence:
            if nid not in seen_done:
                _emit(job_id, nid, "done")

        output = str(result)
        if warnings:
            output = f"[warnings]\n{chr(10).join(warnings)}\n\n{output}"

        _jobs[job_id].update(status="done", result=output, ended_at=datetime.now(timezone.utc))

    except Exception as exc:
        # Mark all still-pending/running nodes as error
        latest: dict[str, str] = {}
        for ev in _jobs[job_id]["node_events"]:
            latest[ev["node_id"]] = ev["status"]
        for nid, st in latest.items():
            if st in ("pending", "running"):
                _emit(job_id, nid, "error")

        _jobs[job_id].update(status="error", error=str(exc), ended_at=datetime.now(timezone.utc))


@router.post("", status_code=202)
async def run_flow(
    req:        RunRequest,
    background: BackgroundTasks,
    runtime:    str | None = Query(default=None),
    user:       User       = Depends(current_user),
):
    spec = req.spec
    if "nodes" not in spec:
        raise HTTPException(status_code=400, detail="spec.nodes is required")

    if not runtime:
        runtime = spec.get("runtime_hints", {}).get("preferred_adapter", "crewai")

    runtime = runtime.lower()
    if runtime != "crewai":
        raise HTTPException(
            status_code=400,
            detail=f"Runtime '{runtime}' is not yet executable. Supported: crewai",
        )

    job_id = str(uuid.uuid4())
    _jobs[job_id] = dict(
        job_id=job_id, status="queued", runtime=runtime,
        started_at=datetime.now(timezone.utc),
        ended_at=None, result=None, error=None,
        node_events=[],
    )
    background.add_task(_run_crewai, job_id, spec)
    return {"job_id": job_id, "status": "queued", "runtime": runtime}


@router.get("/{job_id}", response_model=JobStatusResponse)
async def job_status(job_id: str, user: User = Depends(current_user)):
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job
