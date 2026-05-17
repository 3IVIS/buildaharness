"""
Flow execution endpoint.

POST /run?runtime=crewai|langgraph  → compile + execute (async job), returns {job_id}
GET  /run/{job_id}                  → job status + result + node_events stream
POST /run/{job_id}/resume           → resume a paused LangGraph flow (HITL)

Fixes applied:
  #2  — job_status and resume_flow now verify the requesting user owns the job.
  #6  — rate limiting on POST /run via slowapi.
  #15 — _jobs TTL eviction: completed/errored jobs older than JOB_TTL_HOURS are pruned.
  #16 — asyncio.get_event_loop() replaced with asyncio.get_running_loop().
  #22 — _build_initial_state handles null/array/union types correctly.
  #23 — _is_interrupt uses langgraph.errors.GraphInterrupt isinstance check.
  #24 — POST /run default runtime changed to "langgraph" (matches canvas default).
  #25 — POST /run now calls validate_spec() before exec(), closing the fn_ref
        injection bypass that existed when hitting /run directly instead of /compile.
"""
import asyncio
import contextvars
import json as _json
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from rate_limit import limiter   # Fix #2: shared instance wired to app.state in main.py

from db import User
from auth import current_user
from crewai_adapter import compile_crewai, safe_id
from langgraph_adapter import compile_langgraph
from validate import validate_spec as _validate_spec  # Fix #25: fn_ref check before exec()

# Fix #23: import the real LangGraph interrupt type for isinstance checking.
try:
    from langgraph.errors import GraphInterrupt as _GraphInterrupt
    _HAS_LANGGRAPH = True
except ImportError:
    _GraphInterrupt = None  # type: ignore[assignment,misc]
    _HAS_LANGGRAPH  = False

# ─── Langfuse + OTel setup ───────────────────────────────────────────────────
try:
    from langfuse import observe as _lf_observe, get_client as _lf_get_client
    from opentelemetry import trace as _otel_trace
    _itsharness_tracer = _otel_trace.get_tracer("itsharness.nodes", "0.1.0")
    _LANGFUSE_ENABLED = bool(os.getenv("LANGFUSE_PUBLIC_KEY"))
except ImportError:
    _LANGFUSE_ENABLED = False
    def _lf_observe(func=None, **_kw):          # type: ignore[misc]
        return func if func is not None else (lambda f: f)
    def _lf_get_client():                        # type: ignore[misc]
        return None
    class _FakeTracer:                           # type: ignore[misc]
        class _FakeSpan:
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def set_attribute(self, *_): pass
        def start_as_current_span(self, *_, **__):
            return self._FakeSpan()
    _itsharness_tracer = _FakeTracer()           # type: ignore[assignment]


def _lf_trace_info() -> tuple[str | None, str | None]:
    if not _LANGFUSE_ENABLED:
        return None, None
    try:
        lf = _lf_get_client()
        return lf.get_current_trace_id(), lf.get_trace_url()
    except Exception:
        return None, None


router  = APIRouter(prefix="/run", tags=["run"])

# Fix #11: the in-memory _jobs dict is NOT shared across processes.  Running
# uvicorn with --workers > 1 (or behind gunicorn with multiple workers) causes
# GET /run/{job_id} or POST /run/{job_id}/resume to land on a different process
# than the one that created the job, returning a spurious 404.
_WEB_CONCURRENCY = int(os.getenv("WEB_CONCURRENCY", "1"))
if _WEB_CONCURRENCY > 1:
    import sys as _sys
    print(
        f"FATAL: WEB_CONCURRENCY={_WEB_CONCURRENCY} but the in-memory job store (_jobs) "
        "is not shared across processes.  Run with a single worker until job state is "
        "persisted to Postgres (Phase 2).  Set WEB_CONCURRENCY=1 or remove the env var.",
        file=_sys.stderr,
    )
    _sys.exit(1)

# Fix #15: jobs older than this are eligible for eviction from the in-memory store.
JOB_TTL_HOURS = int(os.getenv("JOB_TTL_HOURS", "4"))

# In-memory job store — Phase 2 moves this to Postgres.
# Fix #2: each entry now includes user_id so ownership can be verified.
_jobs: dict[str, dict[str, Any]] = {}

JobStatus = Literal["queued", "running", "paused", "done", "error"]


class RunRequest(BaseModel):
    spec: dict

class ResumeRequest(BaseModel):
    payload: dict = {}

class HitlState(BaseModel):
    node_id:              str
    prompt:               str
    resume_schema_fields: list[str] = []

class NodeEvent(BaseModel):
    node_id: str
    status:  Literal["pending", "running", "paused", "done", "error"]
    ts:      str
    ms:      int | None = None
    tokens:  int | None = None

class JobStatusResponse(BaseModel):
    job_id:      str
    status:      JobStatus
    runtime:     str
    started_at:  datetime
    ended_at:    datetime | None = None
    result:      str | None = None
    error:       str | None = None
    node_events: list[dict]   = []
    hitl_state:  HitlState | None = None
    trace_id:    str | None = None
    trace_url:   str | None = None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

def _emit(
    job_id:  str,
    node_id: str,
    status:  str,
    ms:      int | None = None,
    tokens:  int | None = None,
) -> None:
    _jobs[job_id]["node_events"].append(
        {"node_id": node_id, "status": status, "ts": _now_iso(), "ms": ms, "tokens": tokens}
    )

def _last_running_node(job_id: str) -> str | None:
    for ev in reversed(_jobs[job_id]["node_events"]):
        if ev["status"] == "running":
            return ev["node_id"]
    return None


# Fix #15: evict completed/errored jobs older than JOB_TTL_HOURS to prevent unbounded growth.
def _evict_stale_jobs() -> None:
    cutoff = datetime.now(timezone.utc) - timedelta(hours=JOB_TTL_HOURS)
    stale = [
        jid for jid, job in _jobs.items()
        if job["status"] in ("done", "error")
        and job.get("ended_at") is not None
        and job["ended_at"] < cutoff
    ]
    for jid in stale:
        del _jobs[jid]


# Fix #2: helper that also enforces ownership.
def _get_job_owned(job_id: str, user_id: str) -> dict[str, Any]:
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.get("user_id") != user_id:
        raise HTTPException(status_code=404, detail="Job not found")  # same message — no info leak
    return job


def _extract_interrupt_info(exc: Exception) -> dict:
    if hasattr(exc, "interrupts") and exc.interrupts:
        first = exc.interrupts[0]
        return first.value if hasattr(first, "value") else {}
    if exc.args:
        candidates = exc.args[0]
        if isinstance(candidates, (list, tuple)) and candidates:
            first = candidates[0]
            return first.value if hasattr(first, "value") else {}
    return {}


def _is_interrupt(exc: Exception) -> bool:
    # Fix #23: use isinstance check against the real LangGraph exception type
    # instead of the fragile name heuristic that false-positives on KeyboardInterrupt.
    if _HAS_LANGGRAPH and _GraphInterrupt is not None:
        return isinstance(exc, _GraphInterrupt)
    # Fallback when LangGraph is not installed (tests / non-LG paths).
    return "GraphInterrupt" in type(exc).__name__


def _mark_stale_nodes_done(job_id: str, trackable: list[str]) -> None:
    seen_done = {
        e["node_id"] for e in _jobs[job_id]["node_events"]
        if e["status"] in ("done", "paused")
    }
    for nid in trackable:
        if nid not in seen_done:
            _emit(job_id, nid, "done")


def _mark_error_nodes(job_id: str) -> None:
    latest: dict[str, str] = {}
    for ev in _jobs[job_id]["node_events"]:
        latest[ev["node_id"]] = ev["status"]
    for nid, st in latest.items():
        if st in ("pending", "running"):
            _emit(job_id, nid, "error")


# ─── LangGraph shared streaming helper ────────────────────────────────────────

def _stream_graph(
    job_id:         str,
    compiled_graph: Any,
    inputs:         Any,
    config:         dict,
    trackable:      list[str],
) -> dict:
    final_state:      dict = {}
    node_start_times: dict[str, datetime] = {}

    if trackable:
        node_start_times[trackable[0]] = datetime.now(timezone.utc)
        _emit(job_id, trackable[0], "running")

    for chunk in compiled_graph.stream(inputs, stream_mode="updates", config=config):
        for node_id, state_update in chunk.items():
            if node_id.startswith("__"):
                continue

            t0 = node_start_times.get(node_id, datetime.now(timezone.utc))
            ms = int((datetime.now(timezone.utc) - t0).total_seconds() * 1000)

            try:
                with _itsharness_tracer.start_as_current_span(
                    f"node.{node_id}",
                    attributes={
                        "node.id":       node_id,
                        "flow.job_id":   job_id,
                        "node.ms":       ms,
                    },
                ) as span:
                    span.set_attribute("node.output_keys",
                        str(list(state_update.keys()))[:200] if isinstance(state_update, dict) else "")
            except Exception:
                pass

            _emit(job_id, node_id, "done", ms)

            if isinstance(state_update, dict):
                final_state.update(state_update)

            try:
                idx = trackable.index(node_id)
                if idx + 1 < len(trackable):
                    nxt = trackable[idx + 1]
                    node_start_times[nxt] = datetime.now(timezone.utc)
                    _emit(job_id, nxt, "running")
            except ValueError:
                pass

    return final_state


# ─── CrewAI runner ────────────────────────────────────────────────────────────

@_lf_observe(name="crewai-flow-run", as_type="chain")
async def _run_crewai(job_id: str, spec: dict):
    _jobs[job_id].update(status="running", started_at=datetime.now(timezone.utc))

    trace_id, trace_url = _lf_trace_info()
    if trace_id:
        _jobs[job_id].update(trace_id=trace_id, trace_url=trace_url)

    try:
        code, warnings = compile_crewai(spec)
        namespace: dict = {}
        exec(compile(code, "<crewai_generated>", "exec"), namespace)  # noqa: S102

        crew = namespace.get("crew")
        if crew is None:
            raise RuntimeError("Generated code did not produce a 'crew' variable")

        obj_id_to_node: dict[int, str] = {}
        for node in spec.get("nodes", []):
            nid = node["id"]
            var = f"task_{safe_id(nid)}"
            if var in namespace:
                obj_id_to_node[id(namespace[var])] = nid

        task_sequence: list[str] = [
            obj_id_to_node[id(t)]
            for t in crew.tasks
            if id(t) in obj_id_to_node
        ]

        for i, nid in enumerate(task_sequence):
            _emit(job_id, nid, "running" if i == 0 else "pending")

        task_start: dict[str, datetime] = {}
        if task_sequence:
            task_start[task_sequence[0]] = datetime.now(timezone.utc)

        for i, task in enumerate(crew.tasks):
            nid      = obj_id_to_node.get(id(task))
            if nid is None:
                continue
            next_nid = task_sequence[i + 1] if i + 1 < len(task_sequence) else None

            def make_cb(node_id: str, next_node_id: str | None):
                def cb(task_output):
                    elapsed = None
                    if node_id in task_start:
                        elapsed = int(
                            (datetime.now(timezone.utc) - task_start[node_id])
                            .total_seconds() * 1000
                        )
                    tokens: int | None = None
                    try:
                        usage = getattr(task_output, "token_usage", None)
                        if usage:
                            tokens = int(
                                getattr(usage, "total_tokens", None)
                                or getattr(usage, "prompt_tokens", 0)
                                + getattr(usage, "completion_tokens", 0)
                                or 0
                            ) or None
                    except Exception:
                        pass
                    _emit(job_id, node_id, "done", elapsed, tokens)
                    if next_node_id:
                        task_start[next_node_id] = datetime.now(timezone.utc)
                        _emit(job_id, next_node_id, "running")
                return cb

            task.callback = make_cb(nid, next_nid)

        # Fix #16: get_running_loop() instead of deprecated get_event_loop()
        loop   = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, crew.kickoff)

        seen_done = {e["node_id"] for e in _jobs[job_id]["node_events"] if e["status"] == "done"}
        for nid in task_sequence:
            if nid not in seen_done:
                _emit(job_id, nid, "done")

        output = str(result)
        if warnings:
            output = f"[warnings]\n{chr(10).join(warnings)}\n\n{output}"
        _jobs[job_id].update(status="done", result=output, ended_at=datetime.now(timezone.utc))

    except Exception as exc:
        _mark_error_nodes(job_id)
        _jobs[job_id].update(status="error", error=str(exc), ended_at=datetime.now(timezone.utc))


# ─── LangGraph runner ─────────────────────────────────────────────────────────

def _build_initial_state(spec: dict) -> dict:
    """
    Fix #22: correctly handle all JSON Schema primitive types including
    null, union arrays, and unknown types (rather than silently defaulting to "").
    """
    schema   = spec.get("state_schema") or {}
    props    = schema.get("properties") or {}
    required = schema.get("required") or []

    _type_defaults: dict[str, Any] = {
        "string":  "",
        "number":  0.0,
        "integer": 0,
        "boolean": False,
        "array":   [],
        "object":  {},
        "null":    None,
    }

    result: dict[str, Any] = {}
    for field in required:
        field_schema = props.get(field) or {}
        field_type   = field_schema.get("type", "string")

        # Handle union type arrays (e.g. ["string", "null"]) — pick first non-null type.
        if isinstance(field_type, list):
            non_null = [t for t in field_type if t != "null"]
            field_type = non_null[0] if non_null else "null"

        # Use explicit default from schema if provided.
        if "default" in field_schema:
            result[field] = field_schema["default"]
        else:
            result[field] = _type_defaults.get(field_type, None)  # None for unknown types

    return result


@_lf_observe(name="langgraph-flow-run", as_type="chain")
async def _run_langgraph(job_id: str, spec: dict):
    _jobs[job_id].update(status="running", started_at=datetime.now(timezone.utc))

    trace_id, trace_url = _lf_trace_info()
    if trace_id:
        _jobs[job_id].update(trace_id=trace_id, trace_url=trace_url)

    try:
        code, warnings = compile_langgraph(spec)
        namespace: dict = {}
        exec(compile(code, "<langgraph_generated>", "exec"), namespace)  # noqa: S102

        compiled_graph = namespace.get("compiled")
        if compiled_graph is None:
            raise RuntimeError("Generated code did not produce a 'compiled' variable")

        config    = {"configurable": {"thread_id": job_id}}
        skip      = {"input", "output", "annotation"}
        trackable = [n["id"] for n in spec.get("nodes", []) if n.get("type") not in skip]

        _jobs[job_id]["compiled_graph"] = compiled_graph
        _jobs[job_id]["lg_config"]      = config
        _jobs[job_id]["trackable"]      = trackable

        for nid in trackable:
            _emit(job_id, nid, "pending")

        initial_state = _build_initial_state(spec)

        ctx  = contextvars.copy_context()
        loop = asyncio.get_running_loop()   # Fix #16

        try:
            final_state = await loop.run_in_executor(
                None, ctx.run, _stream_graph,
                job_id, compiled_graph, initial_state, config, trackable,
            )
        except Exception as exc:
            if _is_interrupt(exc):
                _handle_pause(job_id, exc)
                return
            raise

        _mark_stale_nodes_done(job_id, trackable)

        output = _json.dumps(final_state, default=str, indent=2)
        if warnings:
            output = f"[warnings]\n{chr(10).join(warnings)}\n\n{output}"
        _jobs[job_id].update(status="done", result=output, ended_at=datetime.now(timezone.utc))

    except Exception as exc:
        _mark_error_nodes(job_id)
        _jobs[job_id].update(status="error", error=str(exc), ended_at=datetime.now(timezone.utc))


def _handle_pause(job_id: str, exc: Exception) -> None:
    interrupt_val = _extract_interrupt_info(exc)
    node_id       = _last_running_node(job_id) or "unknown"
    _emit(job_id, node_id, "paused")
    _jobs[job_id].update(
        status="paused",
        hitl_state={
            "node_id":              node_id,
            "prompt":               interrupt_val.get("prompt", "Human review required."),
            "resume_schema_fields": interrupt_val.get("resume_schema_fields", []),
        },
        ended_at=None,
    )


@_lf_observe(name="langgraph-flow-resume", as_type="chain")
async def _resume_langgraph(job_id: str, resume_payload: dict):
    _jobs[job_id].update(status="running", hitl_state=None)

    trace_id, trace_url = _lf_trace_info()
    if trace_id and not _jobs[job_id].get("trace_id"):
        _jobs[job_id].update(trace_id=trace_id, trace_url=trace_url)

    try:
        from langgraph.types import Command

        compiled_graph = _jobs[job_id].get("compiled_graph")
        config         = _jobs[job_id].get("lg_config", {})
        trackable      = _jobs[job_id].get("trackable", [])

        if compiled_graph is None:
            raise RuntimeError("No compiled graph found for this job — cannot resume")

        ctx  = contextvars.copy_context()
        loop = asyncio.get_running_loop()   # Fix #16

        try:
            final_state = await loop.run_in_executor(
                None, ctx.run, _stream_graph,
                job_id, compiled_graph, Command(resume=resume_payload), config, trackable,
            )
        except Exception as exc:
            if _is_interrupt(exc):
                _handle_pause(job_id, exc)
                return
            raise

        _mark_stale_nodes_done(job_id, trackable)

        output = _json.dumps(final_state, default=str, indent=2)
        _jobs[job_id].update(status="done", result=output, ended_at=datetime.now(timezone.utc))

    except Exception as exc:
        _mark_error_nodes(job_id)
        _jobs[job_id].update(status="error", error=str(exc), ended_at=datetime.now(timezone.utc))


# ─── Routes ───────────────────────────────────────────────────────────────────

@router.post("", status_code=202)
@limiter.limit("20/minute")   # Fix #6: rate-limit flow execution
async def run_flow(
    request:    Request,
    req:        RunRequest,
    background: BackgroundTasks,
    runtime:    str | None = Query(default=None),
    user:       User       = Depends(current_user),
):
    spec = req.spec

    # Fix #25: validate the full spec — including fn_ref allowlist — before any
    # codegen or exec() runs.  Previously only /compile called _validate_spec();
    # a request posted directly to /run skipped fn_ref validation entirely,
    # allowing path-traversal or shell-injection strings to reach exec().
    # Note: _validate_spec also checks for nodes/edges/spec_version, making the
    # old bare 'nodes not in spec' guard below redundant — it is removed here.
    _validate_spec(spec)

    # Fix #24: default to "langgraph" to match the canvas preferred_adapter default.
    if not runtime:
        runtime = spec.get("runtime_hints", {}).get("preferred_adapter", "langgraph")
    runtime = runtime.lower()

    if runtime not in {"crewai", "langgraph"}:
        raise HTTPException(
            status_code=400,
            detail=f"Runtime '{runtime}' is not yet executable. Supported: crewai, langgraph",
        )

    # Fix #15: opportunistic eviction before creating new entries.
    _evict_stale_jobs()

    job_id = str(uuid.uuid4())
    # Fix #2: store user_id in job dict so ownership can be verified.
    _jobs[job_id] = dict(
        job_id=job_id,
        user_id=str(user.id),   # Fix #2
        status="queued",
        runtime=runtime,
        started_at=datetime.now(timezone.utc),
        ended_at=None, result=None, error=None,
        node_events=[], hitl_state=None,
        trace_id=None, trace_url=None,
        compiled_graph=None, lg_config=None, trackable=[],
    )

    if runtime == "langgraph":
        background.add_task(_run_langgraph, job_id, spec)
    else:
        background.add_task(_run_crewai, job_id, spec)

    return {"job_id": job_id, "status": "queued", "runtime": runtime}


@router.post("/{job_id}/resume", status_code=202)
async def resume_flow(
    job_id:     str,
    req:        ResumeRequest,
    background: BackgroundTasks,
    user:       User = Depends(current_user),
):
    # Fix #2: _get_job_owned enforces ownership.
    job = _get_job_owned(job_id, str(user.id))
    if job["status"] != "paused":
        raise HTTPException(status_code=409, detail=f"Job is '{job['status']}', not paused")
    if job["runtime"] != "langgraph":
        raise HTTPException(status_code=400, detail="Only LangGraph jobs support HITL resume")

    background.add_task(_resume_langgraph, job_id, req.payload)
    return {"job_id": job_id, "status": "running"}


@router.get("/{job_id}", response_model=JobStatusResponse)
async def job_status(job_id: str, user: User = Depends(current_user)):
    # Fix #2: _get_job_owned enforces ownership.
    job = _get_job_owned(job_id, str(user.id))
    return {k: v for k, v in job.items() if k in JobStatusResponse.model_fields}
