"""
Flow execution endpoint.

POST /run?runtime=crewai|langgraph  → compile + execute (async job), returns {job_id}
GET  /run/{job_id}                  → job status + result + node_events stream
POST /run/{job_id}/resume           → resume a paused LangGraph flow (HITL)

Fixes applied (inherited from prior passes):
  #2  — job_status and resume_flow verify the requesting user owns the job.
  #6  — rate limiting on POST /run via slowapi.
  #15 — jobs older than JOB_TTL_HOURS are evicted (now via a DB DELETE).
  #16 — asyncio.get_event_loop() replaced with asyncio.get_running_loop().
  #22 — _build_initial_state handles null/array/union types correctly.
  #23 — _is_interrupt uses langgraph.errors.GraphInterrupt isinstance check.
  #24 — POST /run default runtime changed to "langgraph".
  #25 — POST /run calls validate_spec() before exec().
  Prompt versioning — resolve_prompts() called after validate_spec().

Phase 3 — Postgres job store (migration 0004):
  - _jobs in-memory dict removed entirely.
  - All job reads/writes go through the Job ORM model via async SQLAlchemy.
  - WEB_CONCURRENCY guard removed — multiple workers are now safe.
  - Background tasks use a dedicated _bg_SessionLocal to get DB sessions
    outside the request/response lifecycle.
  - LangGraph resume re-compiles the graph from the flow spec if the
    process-local _lg_runtime_state was lost after a restart.
  - _evict_stale_jobs() issues a DELETE WHERE status IN ('done','error')
    AND ended_at < cutoff instead of iterating an in-memory dict.
  - a2a_api.py imports the public helpers (_jobs_get, _jobs_create,
    _evict_stale_jobs) rather than the raw dict.
"""
import asyncio
import contextvars
import json as _json
import os
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from rate_limit import limiter
from db import DATABASE_URL, Job, User, get_session
from auth import current_user
from org_context import OrgDep, Org, current_org as _current_org
from crewai_adapter import compile_crewai, safe_id
from langgraph_adapter import compile_langgraph
from prompt_resolver import resolve_prompts
from validate import validate_spec as _validate_spec
import httpx as _httpx

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


router = APIRouter(prefix="/run", tags=["run"])

JOB_TTL_HOURS = int(os.getenv("JOB_TTL_HOURS", "4"))

JobStatus = Literal["queued", "running", "paused", "done", "error"]


# ─── Pydantic models ──────────────────────────────────────────────────────────

class RunRequest(BaseModel):
    spec: dict

class ResumeRequest(BaseModel):
    payload: dict = {}
    # Optional: pass original spec so resume can recompile after a restart.
    spec: dict = {}

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


# ─── Background-task DB session factory ──────────────────────────────────────
#
# Background tasks run outside the request/response lifecycle so they cannot
# use the request-scoped `get_session` dependency.  We create a dedicated
# engine + session factory here.
#
# In test mode (TESTING=true, SQLite) the same DATABASE_URL in-process engine
# is used, so background tasks and test-client requests share the same rows.

_bg_engine       = create_async_engine(DATABASE_URL, echo=False)
_bg_SessionLocal = async_sessionmaker(_bg_engine, expire_on_commit=False)


def configure_bg_session(factory: async_sessionmaker) -> None:
    """Override the background-task session factory.

    Called by the test suite to point the background runners at the same
    per-test in-memory engine that the HTTP client fixture uses.  Must be
    called before any background tasks are dispatched.
    """
    global _bg_SessionLocal
    _bg_SessionLocal = factory


@asynccontextmanager
async def _job_session():
    """Async context manager for a DB session in a background task."""
    async with _bg_SessionLocal() as session:
        yield session


# ─── Public job-store helpers (used by a2a_api too) ───────────────────────────

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _jobs_get(job_id: str, db: AsyncSession) -> Job | None:
    """Return a Job row by ID, or None."""
    result = await db.execute(select(Job).where(Job.id == job_id))
    return result.scalar_one_or_none()


async def _jobs_get_owned(job_id: str, user_id: str, db: AsyncSession) -> Job:
    """Return a Job row owned by user_id, or raise 404."""
    job = await _jobs_get(job_id, db)
    if not job or str(job.user_id) != user_id:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


async def _jobs_create(
    job_id:  str,
    user_id: str,
    runtime: str,
    db:      AsyncSession,
    *,
    org_id: str | None = None,
    extra: dict | None = None,
) -> Job:
    """Insert a new queued Job row and return it."""
    now = datetime.now(timezone.utc)
    row = Job(
        id          = job_id,
        user_id     = uuid.UUID(user_id),
        org_id      = uuid.UUID(org_id) if org_id else None,
        status      = "queued",
        runtime     = runtime,
        started_at  = now,
        node_events = [],
        **(extra or {}),
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


async def _evict_stale_jobs(db: AsyncSession) -> None:
    """Delete completed/errored jobs older than JOB_TTL_HOURS."""
    cutoff = datetime.now(timezone.utc) - timedelta(hours=JOB_TTL_HOURS)
    await db.execute(
        delete(Job).where(
            Job.status.in_(["done", "error"]),
            Job.ended_at.isnot(None),
            Job.ended_at < cutoff,
        )
    )
    await db.commit()


# ─── Process-local compiled-graph store (HITL only) ──────────────────────────
#
# The compiled LangGraph graph object cannot be serialised to Postgres — it is
# a live Python object.  We keep it in a process-local dict for the duration of
# a paused HITL job so the resume path can reuse it without re-compiling.
#
# If the process restarts between pause and resume, _lg_runtime_state will not
# contain the entry; _resume_langgraph detects this and recompiles from the spec
# that the caller passes in the resume request body.
#
# Non-HITL jobs are evicted from this dict as soon as they reach done/error.

_lg_runtime_state: dict[str, dict[str, Any]] = {}


# ─── Internal node-event / job-update helpers ─────────────────────────────────

async def _emit(
    job_id:  str,
    node_id: str,
    status:  str,
    db:      AsyncSession,
    ms:      int | None = None,
    tokens:  int | None = None,
) -> None:
    """Append a node event to the job row."""
    job = await _jobs_get(job_id, db)
    if job is None:
        return
    events: list = list(job.node_events or [])
    events.append({"node_id": node_id, "status": status,
                   "ts": _now_iso(), "ms": ms, "tokens": tokens})
    job.node_events = events
    await db.commit()


async def _last_running_node(job_id: str, db: AsyncSession) -> str | None:
    job = await _jobs_get(job_id, db)
    if not job:
        return None
    for ev in reversed(job.node_events or []):
        if ev["status"] == "running":
            return ev["node_id"]
    return None


async def _mark_stale_nodes_done(
    job_id: str, trackable: list[str], db: AsyncSession
) -> None:
    job = await _jobs_get(job_id, db)
    if not job:
        return
    seen_done = {
        e["node_id"] for e in (job.node_events or [])
        if e["status"] in ("done", "paused")
    }
    for nid in trackable:
        if nid not in seen_done:
            await _emit(job_id, nid, "done", db)


async def _mark_error_nodes(job_id: str, db: AsyncSession) -> None:
    job = await _jobs_get(job_id, db)
    if not job:
        return
    latest: dict[str, str] = {}
    for ev in (job.node_events or []):
        latest[ev["node_id"]] = ev["status"]
    for nid, st in latest.items():
        if st in ("pending", "running"):
            await _emit(job_id, nid, "error", db)


async def _job_update(job_id: str, db: AsyncSession, **fields: Any) -> None:
    """Set scalar fields on the Job row and commit."""
    job = await _jobs_get(job_id, db)
    if job is None:
        return
    for k, v in fields.items():
        setattr(job, k, v)
    await db.commit()


# ─── LangGraph streaming helper ───────────────────────────────────────────────

def _stream_graph(
    job_id:         str,
    compiled_graph: Any,
    inputs:         Any,
    config:         dict,
    trackable:      list[str],
    emit_cb:        Any,
) -> dict:
    """Stream a LangGraph graph synchronously (runs in an executor thread).

    emit_cb(node_id, status, ms, tokens) schedules async DB writes on the
    main event loop so executor threads can emit events without their own loop.
    """
    final_state:      dict = {}
    node_start_times: dict[str, datetime] = {}

    if trackable:
        node_start_times[trackable[0]] = datetime.now(timezone.utc)
        emit_cb(trackable[0], "running", None, None)

    for chunk in compiled_graph.stream(inputs, stream_mode="updates", config=config):
        for node_id, state_update in chunk.items():
            if node_id.startswith("__"):
                continue

            t0 = node_start_times.get(node_id, datetime.now(timezone.utc))
            ms = int((datetime.now(timezone.utc) - t0).total_seconds() * 1000)

            try:
                with _itsharness_tracer.start_as_current_span(
                    f"node.{node_id}",
                    attributes={"node.id": node_id, "flow.job_id": job_id, "node.ms": ms},
                ) as span:
                    span.set_attribute(
                        "node.output_keys",
                        str(list(state_update.keys()))[:200]
                        if isinstance(state_update, dict) else "",
                    )
            except Exception:
                pass

            emit_cb(node_id, "done", ms, None)

            if isinstance(state_update, dict):
                final_state.update(state_update)

            try:
                idx = trackable.index(node_id)
                if idx + 1 < len(trackable):
                    nxt = trackable[idx + 1]
                    node_start_times[nxt] = datetime.now(timezone.utc)
                    emit_cb(nxt, "running", None, None)
            except ValueError:
                pass

    return final_state


def _make_emit_cb(
    job_id:     str,
    loop:       asyncio.AbstractEventLoop,
    db_factory: Any,
) -> Any:
    """Return a thread-safe synchronous emit callback for _stream_graph."""
    def _cb(node_id: str, status: str, ms: int | None, tokens: int | None) -> None:
        async def _do():
            async with db_factory() as db:
                await _emit(job_id, node_id, status, db, ms, tokens)
        asyncio.run_coroutine_threadsafe(_do(), loop)
    return _cb


# ─── CrewAI runner ────────────────────────────────────────────────────────────

@_lf_observe(name="crewai-flow-run", as_type="chain")
async def _run_crewai(job_id: str, spec: dict, org_id: str | None = None) -> None:
    async with _job_session() as db:
        await _job_update(job_id, db,
                          status="running",
                          started_at=datetime.now(timezone.utc))
        trace_id, trace_url = _lf_trace_info()
        if trace_id:
            await _job_update(job_id, db, trace_id=trace_id, trace_url=trace_url)

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

        async with _job_session() as db:
            for i, nid in enumerate(task_sequence):
                await _emit(job_id, nid, "running" if i == 0 else "pending", db)

        task_start: dict[str, datetime] = {}
        if task_sequence:
            task_start[task_sequence[0]] = datetime.now(timezone.utc)

        loop = asyncio.get_running_loop()

        for i, task in enumerate(crew.tasks):
            nid      = obj_id_to_node.get(id(task))
            if nid is None:
                continue
            next_nid = task_sequence[i + 1] if i + 1 < len(task_sequence) else None

            def make_cb(node_id: str, next_node_id: str | None):
                def cb(task_output):
                    elapsed: int | None = None
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

                    async def _do():
                        async with _job_session() as _db:
                            await _emit(job_id, node_id, "done", _db, elapsed, tokens)
                            if next_node_id:
                                task_start[next_node_id] = datetime.now(timezone.utc)
                                await _emit(job_id, next_node_id, "running", _db)
                    asyncio.run_coroutine_threadsafe(_do(), loop)
                return cb

            task.callback = make_cb(nid, next_nid)

        result = await loop.run_in_executor(None, crew.kickoff)

        async with _job_session() as db:
            job = await _jobs_get(job_id, db)
            if job:
                seen_done = {
                    e["node_id"] for e in (job.node_events or [])
                    if e["status"] == "done"
                }
                for nid in task_sequence:
                    if nid not in seen_done:
                        await _emit(job_id, nid, "done", db)

        output = str(result)
        if warnings:
            output = f"[warnings]\n{chr(10).join(warnings)}\n\n{output}"

        async with _job_session() as db:
            await _job_update(job_id, db,
                              status="done",
                              result=output,
                              ended_at=datetime.now(timezone.utc))

    except Exception as exc:
        async with _job_session() as db:
            await _mark_error_nodes(job_id, db)
            await _job_update(job_id, db,
                              status="error",
                              error=str(exc),
                              ended_at=datetime.now(timezone.utc))


# ─── Mastra runner client ─────────────────────────────────────────────────────
#
# The Mastra runner is a separate Node.js sidecar (mastra-runner/).  We forward
# the compiled TypeScript there via HTTP, then poll for the result.
#
# MASTRA_RUNNER_URL — base URL of the sidecar (default: http://mastra-runner:8001)
# MASTRA_RUNNER_API_KEY — shared bearer token (empty = no auth, dev only)
# MASTRA_POLL_INTERVAL_S — how often to poll sidecar for status (default 0.8s)
# MASTRA_RUNNER_TIMEOUT_S — maximum wall-clock seconds before a job is failed
#
# If the runner is unreachable we raise RuntimeError so the job lands in "error"
# rather than silently staying "queued" forever.

MASTRA_RUNNER_URL      = os.getenv("MASTRA_RUNNER_URL",      "http://mastra-runner:8001")
MASTRA_RUNNER_API_KEY  = os.getenv("MASTRA_RUNNER_API_KEY",  "")
MASTRA_POLL_INTERVAL   = float(os.getenv("MASTRA_POLL_INTERVAL_S",   "0.8"))
MASTRA_RUNNER_TIMEOUT  = float(os.getenv("MASTRA_RUNNER_TIMEOUT_S",  str(60 * 60)))


def _mastra_headers() -> dict[str, str]:
    h: dict[str, str] = {"Content-Type": "application/json"}
    if MASTRA_RUNNER_API_KEY:
        h["Authorization"] = f"Bearer {MASTRA_RUNNER_API_KEY}"
    return h


@_lf_observe(name="mastra-flow-run", as_type="chain")
async def _run_mastra(job_id: str, spec: dict, org_id: str | None = None) -> None:
    """Execute a Mastra workflow via the Node.js runner sidecar.

    Steps:
      1. Compile the spec to TypeScript via compile_mastra().
      2. POST the code to the sidecar's /execute endpoint.
      3. Poll the sidecar's /jobs/:job_id endpoint, writing node events
         into the Postgres job row as they arrive.
      4. When the sidecar reports done/error, finalise the Postgres row.
    """
    from mastra_adapter import compile_mastra

    async with _job_session() as db:
        await _job_update(job_id, db,
                          status="running",
                          started_at=datetime.now(timezone.utc))
        trace_id, trace_url = _lf_trace_info()
        if trace_id:
            await _job_update(job_id, db, trace_id=trace_id, trace_url=trace_url)

    try:
        # ── 1. Codegen ────────────────────────────────────────────────────────
        code, warnings = compile_mastra(spec)

        # ── 2. Submit to sidecar ──────────────────────────────────────────────
        payload = {
            "job_id":       job_id,
            "code":         code,
            "trigger_data": {},   # future: extract from spec.input_defaults
        }
        async with _httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{MASTRA_RUNNER_URL}/execute",
                json=payload,
                headers=_mastra_headers(),
            )

        if resp.status_code == 409:
            # Duplicate submission — treat as already running (idempotent).
            pass
        elif resp.status_code != 202:
            raise RuntimeError(
                f"Mastra runner rejected job: HTTP {resp.status_code} — {resp.text[:300]}"
            )

        # ── 3. Emit initial node events (pending) ─────────────────────────────
        skip      = {"input", "output", "annotation"}
        trackable = [n["id"] for n in spec.get("nodes", []) if n.get("type") not in skip]
        async with _job_session() as db:
            for nid in trackable:
                await _emit(job_id, nid, "pending", db)

        # ── 4. Poll sidecar until terminal ────────────────────────────────────
        sent_events: int = 0
        poll_deadline = asyncio.get_running_loop().time() + MASTRA_RUNNER_TIMEOUT
        while True:
            await asyncio.sleep(MASTRA_POLL_INTERVAL)

            if asyncio.get_running_loop().time() > poll_deadline:
                raise RuntimeError(
                    f"Mastra job exceeded the runner timeout "
                    f"({MASTRA_RUNNER_TIMEOUT:.0f}s) without completing. "
                    "Check the sidecar logs."
                )

            async with _httpx.AsyncClient(timeout=10) as client:
                poll = await client.get(
                    f"{MASTRA_RUNNER_URL}/jobs/{job_id}",
                    headers=_mastra_headers(),
                )

            if poll.status_code == 404:
                raise RuntimeError("Mastra runner lost the job (404) — runner may have restarted")

            if poll.status_code != 200:
                raise RuntimeError(f"Mastra runner poll error: HTTP {poll.status_code}")

            data = poll.json()
            runner_events: list[dict] = data.get("node_events", [])

            # Sync new events to the Postgres job row.
            new_events = runner_events[sent_events:]
            if new_events:
                async with _job_session() as db:
                    for ev in new_events:
                        await _emit(
                            job_id,
                            ev["node_id"],
                            ev["status"],
                            db,
                            ev.get("ms"),
                            ev.get("tokens"),
                        )
                sent_events += len(new_events)

            runner_status = data.get("status", "running")

            if runner_status == "done":
                result = data.get("result", "")
                if warnings:
                    result = f"[warnings]\n{chr(10).join(warnings)}\n\n{result}"
                async with _job_session() as db:
                    await _job_update(job_id, db,
                                      status="done",
                                      result=result,
                                      ended_at=datetime.now(timezone.utc))
                _lg_runtime_state.pop(job_id, None)
                return

            if runner_status == "error":
                error = data.get("error", "Unknown Mastra runner error")
                async with _job_session() as db:
                    await _mark_error_nodes(job_id, db)
                    await _job_update(job_id, db,
                                      status="error",
                                      error=error,
                                      ended_at=datetime.now(timezone.utc))
                return

    except Exception as exc:
        async with _job_session() as db:
            await _mark_error_nodes(job_id, db)
            await _job_update(job_id, db,
                              status="error",
                              error=str(exc),
                              ended_at=datetime.now(timezone.utc))


# ─── LangGraph helpers ────────────────────────────────────────────────────────

def _build_initial_state(spec: dict) -> dict:
    schema   = spec.get("state_schema") or {}
    props    = schema.get("properties") or {}
    required = schema.get("required") or []

    _type_defaults: dict[str, Any] = {
        "string":  "", "number": 0.0, "integer": 0,
        "boolean": False, "array": [], "object": {}, "null": None,
    }

    result: dict[str, Any] = {}
    for field in required:
        field_schema = props.get(field) or {}
        field_type   = field_schema.get("type", "string")

        if isinstance(field_type, list):
            non_null = [t for t in field_type if t != "null"]
            field_type = non_null[0] if non_null else "null"

        if "default" in field_schema:
            result[field] = field_schema["default"]
        else:
            result[field] = _type_defaults.get(field_type, None)

    return result


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
    if _HAS_LANGGRAPH and _GraphInterrupt is not None:
        return isinstance(exc, _GraphInterrupt)
    return "GraphInterrupt" in type(exc).__name__


# ─── LangGraph runner ─────────────────────────────────────────────────────────

@_lf_observe(name="langgraph-flow-run", as_type="chain")
async def _run_langgraph(job_id: str, spec: dict, org_id: str | None = None) -> None:
    async with _job_session() as db:
        await _job_update(job_id, db,
                          status="running",
                          started_at=datetime.now(timezone.utc))
        trace_id, trace_url = _lf_trace_info()
        if trace_id:
            await _job_update(job_id, db, trace_id=trace_id, trace_url=trace_url)

    try:
        code, warnings = compile_langgraph(spec)
        namespace: dict = {}
        exec(compile(code, "<langgraph_generated>", "exec"), namespace)  # noqa: S102

        compiled_graph = namespace.get("compiled")
        if compiled_graph is None:
            raise RuntimeError("Generated code did not produce a 'compiled' variable")

        # Namespace the LangGraph checkpointer thread_id with org_id so memory
        # state is siloed per tenant: {org_id}:{job_id} on Postgres checkpointer.
        _thread_id = f"{org_id}:{job_id}" if org_id else job_id
        config    = {"configurable": {"thread_id": _thread_id}}
        skip      = {"input", "output", "annotation"}
        trackable = [n["id"] for n in spec.get("nodes", []) if n.get("type") not in skip]

        _lg_runtime_state[job_id] = {
            "compiled_graph": compiled_graph,
            "lg_config":      config,
            "trackable":      trackable,
        }

        async with _job_session() as db:
            for nid in trackable:
                await _emit(job_id, nid, "pending", db)

        initial_state = _build_initial_state(spec)
        loop          = asyncio.get_running_loop()
        emit_cb       = _make_emit_cb(job_id, loop, _job_session)
        ctx           = contextvars.copy_context()

        try:
            final_state = await loop.run_in_executor(
                None, ctx.run, _stream_graph,
                job_id, compiled_graph, initial_state, config, trackable, emit_cb,
            )
        except Exception as exc:
            if _is_interrupt(exc):
                await _handle_pause(job_id, exc)
                return
            raise

        async with _job_session() as db:
            await _mark_stale_nodes_done(job_id, trackable, db)

        output = _json.dumps(final_state, default=str, indent=2)
        if warnings:
            output = f"[warnings]\n{chr(10).join(warnings)}\n\n{output}"

        async with _job_session() as db:
            await _job_update(job_id, db,
                              status="done",
                              result=output,
                              ended_at=datetime.now(timezone.utc))

        _lg_runtime_state.pop(job_id, None)

    except Exception as exc:
        async with _job_session() as db:
            await _mark_error_nodes(job_id, db)
            await _job_update(job_id, db,
                              status="error",
                              error=str(exc),
                              ended_at=datetime.now(timezone.utc))
        _lg_runtime_state.pop(job_id, None)


async def _handle_pause(job_id: str, exc: Exception) -> None:
    interrupt_val = _extract_interrupt_info(exc)
    async with _job_session() as db:
        node_id = await _last_running_node(job_id, db) or "unknown"
        await _emit(job_id, node_id, "paused", db)
        await _job_update(job_id, db,
                          status="paused",
                          hitl_state={
                              "node_id":              node_id,
                              "prompt":               interrupt_val.get("prompt", "Human review required."),
                              "resume_schema_fields": interrupt_val.get("resume_schema_fields", []),
                          },
                          ended_at=None)


@_lf_observe(name="langgraph-flow-resume", as_type="chain")
async def _resume_langgraph(job_id: str, resume_payload: dict, spec: dict,
                             org_id: str | None = None) -> None:
    """Resume a paused LangGraph job.

    Re-uses the compiled graph from _lg_runtime_state when available.
    Falls back to recompiling from spec if the process restarted since the job
    was paused (spec must be passed in the ResumeRequest body in that case).
    """
    async with _job_session() as db:
        await _job_update(job_id, db, status="running", hitl_state=None)
        trace_id, trace_url = _lf_trace_info()
        if trace_id:
            job = await _jobs_get(job_id, db)
            if job and not job.trace_id:
                await _job_update(job_id, db, trace_id=trace_id, trace_url=trace_url)

    try:
        from langgraph.types import Command

        rt             = _lg_runtime_state.get(job_id, {})
        compiled_graph = rt.get("compiled_graph")
        config         = rt.get("lg_config")
        trackable      = rt.get("trackable")

        if compiled_graph is None:
            # Process restarted — recompile from the spec supplied by the caller.
            if not spec:
                raise RuntimeError(
                    "Cannot resume: compiled graph was lost after a process restart. "
                    "Re-submit the original flow spec in the 'spec' field of the resume request."
                )
            code, _ = compile_langgraph(spec)
            namespace: dict = {}
            exec(compile(code, "<langgraph_generated>", "exec"), namespace)  # noqa: S102
            compiled_graph = namespace.get("compiled")
            if compiled_graph is None:
                raise RuntimeError("Re-compile after restart: no 'compiled' variable")
            _thread_id = f"{org_id}:{job_id}" if org_id else job_id
            config    = {"configurable": {"thread_id": _thread_id}}
            skip      = {"input", "output", "annotation"}
            trackable = [n["id"] for n in spec.get("nodes", []) if n.get("type") not in skip]
            _lg_runtime_state[job_id] = {
                "compiled_graph": compiled_graph,
                "lg_config":      config,
                "trackable":      trackable,
            }

        loop    = asyncio.get_running_loop()
        emit_cb = _make_emit_cb(job_id, loop, _job_session)
        ctx     = contextvars.copy_context()

        try:
            final_state = await loop.run_in_executor(
                None, ctx.run, _stream_graph,
                job_id, compiled_graph, Command(resume=resume_payload),
                config, trackable or [], emit_cb,
            )
        except Exception as exc:
            if _is_interrupt(exc):
                await _handle_pause(job_id, exc)
                return
            raise

        async with _job_session() as db:
            await _mark_stale_nodes_done(job_id, trackable or [], db)

        output = _json.dumps(final_state, default=str, indent=2)

        async with _job_session() as db:
            await _job_update(job_id, db,
                              status="done",
                              result=output,
                              ended_at=datetime.now(timezone.utc))

        _lg_runtime_state.pop(job_id, None)

    except Exception as exc:
        async with _job_session() as db:
            await _mark_error_nodes(job_id, db)
            await _job_update(job_id, db,
                              status="error",
                              error=str(exc),
                              ended_at=datetime.now(timezone.utc))
        _lg_runtime_state.pop(job_id, None)


# ─── Routes ───────────────────────────────────────────────────────────────────

@router.post("", status_code=202)
@limiter.limit("20/minute")
async def run_flow(
    request:    Request,
    req:        RunRequest,
    background: BackgroundTasks,
    runtime:    str | None   = Query(default=None),
    user:       User         = Depends(current_user),
    db:         AsyncSession = Depends(get_session),
    org:        Org          = Depends(_current_org),):
    spec = req.spec
    _validate_spec(spec)
    spec = await resolve_prompts(spec, org)

    if not runtime:
        runtime = spec.get("runtime_hints", {}).get("preferred_adapter", "langgraph")
    runtime = runtime.lower()

    if runtime not in {"crewai", "langgraph", "mastra"}:
        raise HTTPException(
            status_code=400,
            detail=f"Runtime '{runtime}' is not yet executable. Supported: crewai, langgraph, mastra",
        )

    await _evict_stale_jobs(db)

    job_id = str(uuid.uuid4())
    org_id = str(org.id) if org else None
    await _jobs_create(job_id, str(user.id), runtime, db, org_id=org_id)

    if runtime == "langgraph":
        background.add_task(_run_langgraph, job_id, spec, org_id)
    elif runtime == "mastra":
        background.add_task(_run_mastra, job_id, spec, org_id)
    else:
        background.add_task(_run_crewai, job_id, spec, org_id)

    return {"job_id": job_id, "status": "queued", "runtime": runtime}


@router.post("/{job_id}/resume", status_code=202)
@limiter.limit("10/minute")
async def resume_flow(
    request:    Request,
    job_id:     str,
    req:        ResumeRequest,
    background: BackgroundTasks,
    user:       User         = Depends(current_user),
    db:         AsyncSession = Depends(get_session),
):
    job = await _jobs_get_owned(job_id, str(user.id), db)
    if job.status != "paused":
        raise HTTPException(status_code=409, detail=f"Job is '{job.status}', not paused")
    if job.runtime != "langgraph":
        raise HTTPException(status_code=400, detail="Only LangGraph jobs support HITL resume")

    background.add_task(_resume_langgraph, job_id, req.payload, req.spec,
                        str(job.org_id) if job.org_id else None)
    return {"job_id": job_id, "status": "running"}


@router.get("/{job_id}", response_model=JobStatusResponse)
async def job_status(
    job_id: str,
    user:   User         = Depends(current_user),
    db:     AsyncSession = Depends(get_session),
):
    job = await _jobs_get_owned(job_id, str(user.id), db)
    return {
        "job_id":      job.id,
        "status":      job.status,
        "runtime":     job.runtime,
        "started_at":  job.started_at,
        "ended_at":    job.ended_at,
        "result":      job.result,
        "error":       job.error,
        "node_events": job.node_events or [],
        "hitl_state":  job.hitl_state,
        "trace_id":    job.trace_id,
        "trace_url":   job.trace_url,
    }
