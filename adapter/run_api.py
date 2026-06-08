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
from datetime import UTC, datetime, timedelta
from typing import Any, Literal, cast

import httpx as _httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from auth import current_user
from crewai_adapter import compile_crewai, safe_id
from db import DATABASE_URL, Job, User, get_session
from langgraph_adapter import compile_langgraph
from maf_adapter import compile_maf
from org_context import Org
from org_context import current_org as _current_org
from prompt_resolver import resolve_prompts
from rate_limit import limiter
from validate import validate_spec as _validate_spec

# ── Process concept registry (P-PC) ──────────────────────────────────────────
# Populated at import time from repo-root concepts/. Absent directory = no-op.
try:
    from harness.process_concept import ProcessConceptNotFoundError as _ProcessConceptNotFoundError
    from harness.process_registry import DEFAULT_REGISTRY as _concept_registry
except ImportError:
    _concept_registry = None  # type: ignore[assignment]
    _ProcessConceptNotFoundError = None  # type: ignore[assignment,misc]

try:
    from langgraph.errors import GraphInterrupt as _GraphInterrupt

    _HAS_LANGGRAPH = True
except ImportError:
    _GraphInterrupt = None  # type: ignore[assignment,misc]
    _HAS_LANGGRAPH = False

# ─── Langfuse + OTel setup ───────────────────────────────────────────────────
try:
    from langfuse import get_client as _lf_get_client
    from langfuse import observe as _lf_observe
    from opentelemetry import trace as _otel_trace

    _itsharness_tracer = _otel_trace.get_tracer("itsharness.nodes", "0.1.0")
    _LANGFUSE_ENABLED = bool(os.getenv("LANGFUSE_PUBLIC_KEY"))
except ImportError:
    _LANGFUSE_ENABLED = False

    def _lf_observe(func=None, **_kw):  # type: ignore[misc]
        return func if func is not None else (lambda f: f)

    def _lf_get_client():  # type: ignore[misc]
        return None

    class _FakeTracer:  # type: ignore[misc]
        class _FakeSpan:
            def __enter__(self):
                return self

            def __exit__(self, *_):
                pass

            def set_attribute(self, *_):
                pass

        def start_as_current_span(self, *_, **__):
            return self._FakeSpan()

    _itsharness_tracer = _FakeTracer()  # type: ignore[assignment]


def _lf_trace_info() -> tuple[str | None, str | None]:
    if not _LANGFUSE_ENABLED:
        return None, None
    try:
        lf = _lf_get_client()
        trace_id = lf.get_current_trace_id()
        trace_url = lf.get_trace_url()
        # get_trace_url() uses the internal Docker hostname (http://langfuse:3000).
        # Rewrite it to LANGFUSE_PUBLIC_URL so the link works in the browser.
        public_url = os.getenv("LANGFUSE_PUBLIC_URL", "").rstrip("/")
        if trace_url and public_url:
            internal_url = os.getenv("LANGFUSE_BASE_URL", "http://langfuse:3000").rstrip("/")
            trace_url = trace_url.replace(internal_url, public_url)
        return trace_id, trace_url
    except Exception:
        return None, None


router = APIRouter(prefix="/run", tags=["run"])

JOB_TTL_HOURS = int(os.getenv("JOB_TTL_HOURS", "4"))

JobStatus = Literal["queued", "running", "paused", "done", "error"]


# ─── Pydantic models ──────────────────────────────────────────────────────────


class RunRequest(BaseModel):
    spec: dict
    inputs: dict = {}  # user-supplied initial state values; merged over schema defaults


class ResumeRequest(BaseModel):
    payload: dict = {}
    # Optional: pass original spec so resume can recompile after a restart.
    spec: dict = {}


class HitlState(BaseModel):
    node_id: str
    prompt: str
    resume_schema_fields: list[str] = []


class NodeEvent(BaseModel):
    node_id: str
    status: Literal["pending", "running", "paused", "done", "error"]
    ts: str
    ms: int | None = None
    tokens: int | None = None
    error_message: str | None = None  # present only when status="error"


class JobStatusResponse(BaseModel):
    job_id: str
    status: JobStatus
    runtime: str
    started_at: datetime
    ended_at: datetime | None = None
    result: str | None = None
    error: str | None = None
    node_events: list[dict] = []
    hitl_state: HitlState | None = None
    trace_id: str | None = None
    trace_url: str | None = None


# ─── Background-task DB session factory ──────────────────────────────────────
#
# Background tasks run outside the request/response lifecycle so they cannot
# use the request-scoped `get_session` dependency.  We create a dedicated
# engine + session factory here.
#
# In test mode (TESTING=true, SQLite) the same DATABASE_URL in-process engine
# is used, so background tasks and test-client requests share the same rows.

_bg_engine = create_async_engine(DATABASE_URL, echo=False)
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
    return datetime.now(UTC).isoformat()


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
    job_id: str,
    user_id: str,
    runtime: str,
    db: AsyncSession,
    *,
    org_id: str | None = None,
    extra: dict | None = None,
) -> Job:
    """Insert a new queued Job row and return it."""
    now = datetime.now(UTC)
    row = Job(
        id=job_id,
        user_id=uuid.UUID(user_id),
        org_id=uuid.UUID(org_id) if org_id else None,
        status="queued",
        runtime=runtime,
        started_at=now,
        node_events=[],
        **(extra or {}),
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


async def _evict_stale_jobs(db: AsyncSession) -> None:
    """Delete completed/errored jobs older than JOB_TTL_HOURS."""
    cutoff = datetime.now(UTC) - timedelta(hours=JOB_TTL_HOURS)
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
    job_id: str,
    node_id: str,
    status: str,
    db: AsyncSession,
    ms: int | None = None,
    tokens: int | None = None,
    error_message: str | None = None,
) -> None:
    """Append a node event to the job row.

    error_message is set when status='error' to carry the exception text so
    the canvas can display it inline on the failing node without a separate
    API call.
    """
    job = await _jobs_get(job_id, db)
    if job is None:
        return
    events: list = list(job.node_events or [])
    event: dict = {"node_id": node_id, "status": status, "ts": _now_iso(), "ms": ms, "tokens": tokens}
    if error_message is not None:
        event["error_message"] = error_message[:2000]  # guard against huge tracebacks
    events.append(event)
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


async def _mark_stale_nodes_done(job_id: str, trackable: list[str], db: AsyncSession) -> None:
    job = await _jobs_get(job_id, db)
    if not job:
        return
    seen_done = {e["node_id"] for e in (job.node_events or []) if e["status"] in ("done", "paused")}
    for nid in trackable:
        if nid not in seen_done:
            await _emit(job_id, nid, "done", db)


async def _mark_error_nodes(
    job_id: str,
    db: AsyncSession,
    error_message: str | None = None,
) -> None:
    """Mark all pending/running nodes as error.

    error_message is attached to the node that was 'running' at the time
    of failure (i.e. the probable cause node).  Pending nodes that never
    ran get no message — they failed because their predecessor failed.
    """
    job = await _jobs_get(job_id, db)
    if not job:
        return
    latest: dict[str, str] = {}
    for ev in job.node_events or []:
        latest[ev["node_id"]] = ev["status"]
    for nid, st in latest.items():
        if st in ("pending", "running"):
            # Only attach the error message to the node that was actively
            # running — that's the node that most likely caused the failure.
            msg = error_message if st == "running" else None
            await _emit(job_id, nid, "error", db, error_message=msg)


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
    job_id: str,
    compiled_graph: Any,
    inputs: Any,
    config: dict,
    trackable: list[str],
    emit_cb: Any,
) -> dict:
    """Stream a LangGraph graph synchronously (runs in an executor thread).

    emit_cb(node_id, status, ms, tokens) schedules async DB writes on the
    main event loop so executor threads can emit events without their own loop.
    """
    final_state: dict = {}
    node_start_times: dict[str, datetime] = {}

    if trackable:
        node_start_times[trackable[0]] = datetime.now(UTC)
        emit_cb(trackable[0], "running", None, None)

    # _current_node tracks which node was running when an exception escapes
    # the stream loop, so we can emit a precise "error" event for that node
    # rather than marking every pending node as error in _mark_error_nodes.
    _current_node: str | None = None

    # In LangGraph >=1.x, interrupt() no longer raises GraphInterrupt from
    # inside stream(). Instead it emits an __interrupt__ chunk and the stream
    # ends cleanly. We capture the value here and re-raise after the loop.
    _pending_interrupt: Any = None

    try:
        for chunk in compiled_graph.stream(inputs, stream_mode="updates", config=config):
            for node_id, state_update in chunk.items():
                if node_id == "__interrupt__":
                    _pending_interrupt = state_update
                    continue
                if node_id.startswith("__"):
                    continue

                _current_node = node_id
                t0 = node_start_times.get(node_id, datetime.now(UTC))
                ms = int((datetime.now(UTC) - t0).total_seconds() * 1000)

                # Check for LangGraph node-level error payloads: when a node
                # raises, LangGraph may surface the error as a special key in
                # state_update rather than propagating it as a Python exception.
                if isinstance(state_update, dict) and "__error__" in state_update:
                    node_err = state_update["__error__"]
                    err_msg = str(node_err) if not isinstance(node_err, str) else node_err
                    emit_cb(node_id, "error", ms, None, err_msg)
                    raise RuntimeError(f"Node '{node_id}' failed: {err_msg}")

                try:
                    with _itsharness_tracer.start_as_current_span(
                        f"node.{node_id}",
                        attributes={"node.id": node_id, "flow.job_id": job_id, "node.ms": ms},
                    ) as span:
                        span.set_attribute(
                            "node.output_keys",
                            str(list(state_update.keys()))[:200] if isinstance(state_update, dict) else "",
                        )
                except Exception:
                    pass

                emit_cb(node_id, "done", ms, None)
                _current_node = None

                if isinstance(state_update, dict):
                    final_state.update(state_update)

                try:
                    idx = trackable.index(node_id)
                    if idx + 1 < len(trackable):
                        nxt = trackable[idx + 1]
                        node_start_times[nxt] = datetime.now(UTC)
                        emit_cb(nxt, "running", None, None)
                        _current_node = nxt
                except ValueError:
                    pass

    except Exception:
        # If we know which node was active, emit a precise error event for it
        # so the canvas highlights exactly the failing node, not all pending nodes.
        if _current_node is not None:
            import sys

            exc_info = sys.exc_info()
            err_msg = str(exc_info[1]) if exc_info[1] else "Unknown error"
            emit_cb(_current_node, "error", None, None, err_msg)
        raise

    # LangGraph >=1.x: interrupt() ends the stream cleanly with an
    # __interrupt__ chunk instead of raising GraphInterrupt. Re-raise so
    # the caller's _is_interrupt() check can route to _handle_pause().
    if _pending_interrupt is not None and _GraphInterrupt is not None:
        raise _GraphInterrupt(_pending_interrupt)

    return final_state


def _make_emit_cb(
    job_id: str,
    loop: asyncio.AbstractEventLoop,
    db_factory: Any,
) -> Any:
    """Return a thread-safe synchronous emit callback for _stream_graph.

    Signature: cb(node_id, status, ms, tokens, error_message=None)
    error_message is forwarded to _emit so it lands in the node_events row
    and the canvas can display it inline.
    """

    def _cb(
        node_id: str,
        status: str,
        ms: int | None,
        tokens: int | None,
        error_message: str | None = None,
    ) -> None:
        async def _do():
            async with db_factory() as db:
                await _emit(job_id, node_id, status, db, ms, tokens, error_message)

        asyncio.run_coroutine_threadsafe(_do(), loop)

    return _cb


# ─── CrewAI runner ────────────────────────────────────────────────────────────


@_lf_observe(name="crewai-flow-run", as_type="chain")
async def _run_crewai(job_id: str, spec: dict, org_id: str | None = None, inputs: dict | None = None) -> None:
    async with _job_session() as db:
        await _job_update(job_id, db, status="running", started_at=datetime.now(UTC))
        trace_id, trace_url = _lf_trace_info()
        if trace_id:
            await _job_update(job_id, db, trace_id=trace_id, trace_url=trace_url)

    try:
        code, warnings = compile_crewai(spec)
        namespace: dict = {"_inputs": inputs or {}}
        exec(compile(code, "<crewai_generated>", "exec"), namespace)

        crew = namespace.get("crew")
        if crew is None:
            raise RuntimeError("Generated code did not produce a 'crew' variable")

        obj_id_to_node: dict[int, str] = {}
        for node in spec.get("nodes", []):
            nid = node["id"]
            var = f"task_{safe_id(nid)}"
            if var in namespace:
                obj_id_to_node[id(namespace[var])] = nid

        task_sequence: list[str] = [obj_id_to_node[id(t)] for t in crew.tasks if id(t) in obj_id_to_node]

        async with _job_session() as db:
            for i, nid in enumerate(task_sequence):
                await _emit(job_id, nid, "running" if i == 0 else "pending", db)

        task_start: dict[str, datetime] = {}
        if task_sequence:
            task_start[task_sequence[0]] = datetime.now(UTC)

        loop = asyncio.get_running_loop()

        for i, task in enumerate(crew.tasks):
            nid = obj_id_to_node.get(id(task))
            if nid is None:
                continue
            next_nid = task_sequence[i + 1] if i + 1 < len(task_sequence) else None

            def make_cb(node_id: str, next_node_id: str | None):
                def cb(task_output):
                    elapsed: int | None = None
                    if node_id in task_start:
                        elapsed = int((datetime.now(UTC) - task_start[node_id]).total_seconds() * 1000)
                    tokens: int | None = None
                    try:
                        usage = getattr(task_output, "token_usage", None)
                        if usage:
                            tokens = (
                                int(
                                    getattr(usage, "total_tokens", None)
                                    or getattr(usage, "prompt_tokens", 0) + getattr(usage, "completion_tokens", 0)
                                    or 0
                                )
                                or None
                            )
                    except Exception:
                        pass

                    async def _do():
                        async with _job_session() as _db:
                            await _emit(job_id, node_id, "done", _db, elapsed, tokens)
                            if next_node_id:
                                task_start[next_node_id] = datetime.now(UTC)
                                await _emit(job_id, next_node_id, "running", _db)

                    asyncio.run_coroutine_threadsafe(_do(), loop)

                return cb

            task.callback = make_cb(nid, next_nid)

        # Pass user inputs so CrewAI substitutes {{key}} placeholders in task descriptions.
        _kickoff_inputs = inputs if inputs else None
        result = await loop.run_in_executor(
            None, lambda: crew.kickoff(inputs=_kickoff_inputs) if _kickoff_inputs else crew.kickoff()
        )

        async with _job_session() as db:
            job = await _jobs_get(job_id, db)
            if job:
                seen_done = {e["node_id"] for e in (job.node_events or []) if e["status"] == "done"}
                for nid in task_sequence:
                    if nid not in seen_done:
                        await _emit(job_id, nid, "done", db)

        output = str(result)
        if warnings:
            output = f"[warnings]\n{chr(10).join(warnings)}\n\n{output}"

        async with _job_session() as db:
            await _job_update(job_id, db, status="done", result=output, ended_at=datetime.now(UTC))

    except Exception as exc:
        async with _job_session() as db:
            await _mark_error_nodes(job_id, db, error_message=str(exc))
            await _job_update(job_id, db, status="error", error=str(exc), ended_at=datetime.now(UTC))


# ─── MS Agent Framework runner ───────────────────────────────────────────────
#
# MAF execution is in-process (like LangGraph) rather than sidecar-based.
# The generated Python code is exec()'d and _run_flow_async is called directly
# in the event loop, with per-node callbacks that emit node events.
#
# HITL: hitl_breakpoint nodes raise _HitlPause which we catch here.
#       Resume re-runs the whole flow with the HITL payload merged into inputs
#       (correct for single-HITL flows; multi-HITL requires Dapr checkpointing).


@_lf_observe(name="maf-flow-run", as_type="chain")
async def _run_maf(job_id: str, spec: dict, org_id: str | None = None, inputs: dict | None = None) -> None:
    async with _job_session() as db:
        await _job_update(job_id, db, status="running", started_at=datetime.now(UTC))
        trace_id, trace_url = _lf_trace_info()
        if trace_id:
            await _job_update(job_id, db, trace_id=trace_id, trace_url=trace_url)

    try:
        code, warnings = compile_maf(spec)
        namespace: dict = {}
        exec(compile(code, "<maf_generated>", "exec"), namespace)

        run_flow_async = namespace.get("_run_flow_async")
        if run_flow_async is None:
            raise RuntimeError("Generated MAF code did not produce a '_run_flow_async' function")

        skip = {"input", "output", "annotation"}
        trackable = [n["id"] for n in spec.get("nodes", []) if n.get("type") not in skip]

        async with _job_session() as db:
            for nid in trackable:
                await _emit(job_id, nid, "pending", db)

        node_start_times: dict[str, datetime] = {}

        async def on_node_start(node_id: str) -> None:
            node_start_times[node_id] = datetime.now(UTC)
            async with _job_session() as db:
                await _emit(job_id, node_id, "running", db)

        async def on_node_done(node_id: str, elapsed_ms: int, tokens: int | None) -> None:
            async with _job_session() as db:
                await _emit(job_id, node_id, "done", db, elapsed_ms, tokens)

        initial_state = _build_initial_state(spec, inputs)

        try:
            final_state = await run_flow_async(
                initial_state,
                on_node_start=on_node_start,
                on_node_done=on_node_done,
            )
        except Exception as exc:
            # Check for _HitlPause raised by hitl_breakpoint nodes
            pause_cls = namespace.get("_HitlPause")
            if pause_cls and isinstance(exc, pause_cls):
                async with _job_session() as db:
                    await _emit(job_id, exc.node_id, "paused", db)
                    await _job_update(
                        job_id,
                        db,
                        status="paused",
                        hitl_state={
                            "node_id": exc.node_id,
                            "prompt": exc.prompt,
                            "resume_schema_fields": exc.fields,
                        },
                        ended_at=None,
                    )
                # Store the compiled namespace and spec so resume can re-run
                _maf_runtime_state[job_id] = {
                    "namespace": namespace,
                    "spec": spec,
                }
                return
            raise

        # Mark any nodes that didn't emit done (e.g. condition branches not taken)
        async with _job_session() as db:
            await _mark_stale_nodes_done(job_id, trackable, db)

        import json as _json_mod

        output = _json_mod.dumps(final_state, default=str, indent=2)
        if warnings:
            output = f"[warnings]\n{chr(10).join(warnings)}\n\n{output}"

        async with _job_session() as db:
            await _job_update(job_id, db, status="done", result=output, ended_at=datetime.now(UTC))

        _maf_runtime_state.pop(job_id, None)

    except Exception as exc:
        async with _job_session() as db:
            await _mark_error_nodes(job_id, db, error_message=str(exc))
            await _job_update(job_id, db, status="error", error=str(exc), ended_at=datetime.now(UTC))
        _maf_runtime_state.pop(job_id, None)


# In-memory map of paused MAF jobs: job_id → {namespace, spec}
# Used to re-inject resume payload on HITL resume.
_maf_runtime_state: dict[str, dict] = {}


@_lf_observe(name="maf-flow-resume", as_type="chain")
async def _resume_maf(job_id: str, resume_payload: dict, spec: dict, org_id: str | None = None) -> None:
    """Resume a paused MAF job by re-running the flow with the HITL payload merged in."""
    # Read the paused job's hitl_state to find out which node paused and its out_key.
    async with _job_session() as db:
        paused_job = await _jobs_get(job_id, db)
        hitl_state_snap = (paused_job.hitl_state or {}) if paused_job else {}
        await _job_update(job_id, db, status="running", ended_at=None)

    # Wrap the resume payload under the node's output_key so the hitl_breakpoint
    # node can find it in state and skip re-raising _HitlPause.
    node_id_snap = hitl_state_snap.get("node_id", "")
    spec_nodes = {n["id"]: n for n in (spec or {}).get("nodes", [])}
    hitl_node = spec_nodes.get(node_id_snap, {})
    out_key = hitl_node.get("output_key") or (node_id_snap.replace("-", "_") + "_resume")
    wrapped_resume = {out_key: resume_payload}

    try:
        # Re-compile from the original spec (or use cached namespace if available)
        rt_state = _maf_runtime_state.get(job_id)
        if rt_state:
            namespace = rt_state["namespace"]
            run_flow_async = namespace.get("_run_flow_async")
        else:
            code, _ = compile_maf(spec or {})
            namespace = {}
            exec(compile(code, "<maf_generated_resume>", "exec"), namespace)
            run_flow_async = namespace.get("_run_flow_async")

        if run_flow_async is None:
            raise RuntimeError("Could not find _run_flow_async for MAF resume")

        skip = {"input", "output", "annotation"}
        trackable = [n["id"] for n in (spec or {}).get("nodes", []) if n.get("type") not in skip]

        async def on_node_start(node_id: str) -> None:
            async with _job_session() as db:
                await _emit(job_id, node_id, "running", db)

        async def on_node_done(node_id: str, elapsed_ms: int, tokens: int | None) -> None:
            async with _job_session() as db:
                await _emit(job_id, node_id, "done", db, elapsed_ms, tokens)

        initial_state = _build_initial_state(spec or {})

        try:
            final_state = await run_flow_async(
                initial_state,
                on_node_start=on_node_start,
                on_node_done=on_node_done,
                _hitl_resume=wrapped_resume,
            )
        except Exception as exc:
            pause_cls = namespace.get("_HitlPause")
            if pause_cls and isinstance(exc, pause_cls):
                # Chained HITL — pause again
                async with _job_session() as db:
                    await _emit(job_id, exc.node_id, "paused", db)
                    await _job_update(
                        job_id,
                        db,
                        status="paused",
                        hitl_state={
                            "node_id": exc.node_id,
                            "prompt": exc.prompt,
                            "resume_schema_fields": exc.fields,
                        },
                        ended_at=None,
                    )
                return
            raise

        async with _job_session() as db:
            await _mark_stale_nodes_done(job_id, trackable, db)

        import json as _json_mod

        output = _json_mod.dumps(final_state, default=str, indent=2)

        async with _job_session() as db:
            await _job_update(job_id, db, status="done", result=output, ended_at=datetime.now(UTC))

        _maf_runtime_state.pop(job_id, None)

    except Exception as exc:
        async with _job_session() as db:
            await _mark_error_nodes(job_id, db, error_message=str(exc))
            await _job_update(job_id, db, status="error", error=str(exc), ended_at=datetime.now(UTC))
        _maf_runtime_state.pop(job_id, None)


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

MASTRA_RUNNER_URL = os.getenv("MASTRA_RUNNER_URL", "http://mastra-runner:8001")
MASTRA_RUNNER_API_KEY = os.getenv("MASTRA_RUNNER_API_KEY", "")
MASTRA_POLL_INTERVAL = float(os.getenv("MASTRA_POLL_INTERVAL_S", "0.8"))
MASTRA_RUNNER_TIMEOUT = float(os.getenv("MASTRA_RUNNER_TIMEOUT_S", str(60 * 60)))


def _mastra_headers() -> dict[str, str]:
    h: dict[str, str] = {"Content-Type": "application/json"}
    if MASTRA_RUNNER_API_KEY:
        h["Authorization"] = f"Bearer {MASTRA_RUNNER_API_KEY}"
    return h


@_lf_observe(name="mastra-flow-run", as_type="chain")
async def _run_mastra(job_id: str, spec: dict, org_id: str | None = None, inputs: dict | None = None) -> None:
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
        await _job_update(job_id, db, status="running", started_at=datetime.now(UTC))
        trace_id, trace_url = _lf_trace_info()
        if trace_id:
            await _job_update(job_id, db, trace_id=trace_id, trace_url=trace_url)

    try:
        # ── 1. Codegen ────────────────────────────────────────────────────────
        code, warnings = compile_mastra(spec)

        # ── 2. Submit to sidecar ──────────────────────────────────────────────
        payload = {
            "job_id": job_id,
            "code": code,
            "trigger_data": inputs or {},  # user-supplied inputs flow to the workflow
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
            raise RuntimeError(f"Mastra runner rejected job: HTTP {resp.status_code} — {resp.text[:300]}")

        # ── 3. Emit initial node events (pending) ─────────────────────────────
        skip = {"input", "output", "annotation"}
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
                    await _job_update(job_id, db, status="done", result=result, ended_at=datetime.now(UTC))
                return result

            if runner_status == "suspended":
                hitl = data.get("hitl_state", {}) or {}
                node_id = hitl.get("node_id", "unknown")
                async with _job_session() as db:
                    await _emit(job_id, node_id, "paused", db)
                    await _job_update(job_id, db, status="paused", hitl_state=hitl, ended_at=datetime.now(UTC))
                return

            if runner_status == "error":
                error = data.get("error", "Unknown Mastra runner error")
                async with _job_session() as db:
                    await _mark_error_nodes(job_id, db, error_message=error)
                    await _job_update(job_id, db, status="error", error=error, ended_at=datetime.now(UTC))
                return

    except Exception as exc:
        async with _job_session() as db:
            await _mark_error_nodes(job_id, db, error_message=str(exc))
            await _job_update(job_id, db, status="error", error=str(exc), ended_at=datetime.now(UTC))


# ─── LangGraph helpers ────────────────────────────────────────────────────────


def _build_initial_state(spec: dict, inputs: dict | None = None) -> dict:
    """Build the initial state dict for a flow run.

    Seeds every field listed in ``state_schema.required`` with its schema
    default (or a sensible type-zero), then overlays the caller-supplied
    *inputs* so that any value the user actually provided wins.
    """
    schema = spec.get("state_schema") or {}
    props = schema.get("properties") or {}
    required = schema.get("required") or []

    _type_defaults: dict[str, Any] = {
        "string": "",
        "number": 0.0,
        "integer": 0,
        "boolean": False,
        "array": [],
        "object": {},
        "null": None,
    }

    result: dict[str, Any] = {}
    for field in required:
        field_schema = props.get(field) or {}
        field_type = field_schema.get("type", "string")

        if isinstance(field_type, list):
            non_null = [t for t in field_type if t != "null"]
            field_type = non_null[0] if non_null else "null"

        if "default" in field_schema:
            result[field] = field_schema["default"]
        else:
            result[field] = _type_defaults.get(field_type, None)

    # User-supplied inputs take priority over schema defaults.
    if inputs:
        result.update(inputs)

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
async def _run_langgraph(job_id: str, spec: dict, org_id: str | None = None, inputs: dict | None = None) -> None:
    async with _job_session() as db:
        await _job_update(job_id, db, status="running", started_at=datetime.now(UTC))
        trace_id, trace_url = _lf_trace_info()
        if trace_id:
            await _job_update(job_id, db, trace_id=trace_id, trace_url=trace_url)

    try:
        code, warnings = compile_langgraph(spec)
        namespace: dict = {}
        exec(compile(code, "<langgraph_generated>", "exec"), namespace)

        compiled_graph = namespace.get("compiled")
        if compiled_graph is None:
            raise RuntimeError("Generated code did not produce a 'compiled' variable")

        # Namespace the LangGraph checkpointer thread_id with org_id so memory
        # state is siloed per tenant: {org_id}:{job_id} on Postgres checkpointer.
        _thread_id = f"{org_id}:{job_id}" if org_id else job_id
        config = {"configurable": {"thread_id": _thread_id}}
        skip = {"input", "output", "annotation"}
        trackable = [n["id"] for n in spec.get("nodes", []) if n.get("type") not in skip]

        _lg_runtime_state[job_id] = {
            "compiled_graph": compiled_graph,
            "lg_config": config,
            "trackable": trackable,
        }

        async with _job_session() as db:
            for nid in trackable:
                await _emit(job_id, nid, "pending", db)

        initial_state = _build_initial_state(spec, inputs)
        loop = asyncio.get_running_loop()
        emit_cb = _make_emit_cb(job_id, loop, _job_session)
        ctx = contextvars.copy_context()

        try:
            final_state = await loop.run_in_executor(
                None,
                ctx.run,
                _stream_graph,
                job_id,
                compiled_graph,
                initial_state,
                config,
                trackable,
                emit_cb,
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
            await _job_update(job_id, db, status="done", result=output, ended_at=datetime.now(UTC))

        _lg_runtime_state.pop(job_id, None)

    except Exception as exc:
        async with _job_session() as db:
            await _mark_error_nodes(job_id, db, error_message=str(exc))
            await _job_update(job_id, db, status="error", error=str(exc), ended_at=datetime.now(UTC))
        _lg_runtime_state.pop(job_id, None)


async def _handle_pause(job_id: str, exc: Exception) -> None:
    interrupt_val = _extract_interrupt_info(exc)
    async with _job_session() as db:
        node_id = await _last_running_node(job_id, db) or "unknown"
        await _emit(job_id, node_id, "paused", db)
        await _job_update(
            job_id,
            db,
            status="paused",
            hitl_state={
                "node_id": node_id,
                "prompt": interrupt_val.get("prompt", "Human review required."),
                "resume_schema_fields": interrupt_val.get("resume_schema_fields", []),
            },
            ended_at=None,
        )


@_lf_observe(name="langgraph-flow-resume", as_type="chain")
async def _resume_langgraph(job_id: str, resume_payload: dict, spec: dict, org_id: str | None = None) -> None:
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

        rt = _lg_runtime_state.get(job_id, {})
        compiled_graph = rt.get("compiled_graph")
        config = rt.get("lg_config")
        trackable = rt.get("trackable")

        if compiled_graph is None:
            # Process restarted — recompile from the spec supplied by the caller.
            if not spec:
                raise RuntimeError(
                    "Cannot resume: compiled graph was lost after a process restart. "
                    "Re-submit the original flow spec in the 'spec' field of the resume request."
                )
            code, _ = compile_langgraph(spec)
            namespace: dict = {}
            exec(compile(code, "<langgraph_generated>", "exec"), namespace)
            compiled_graph = namespace.get("compiled")
            if compiled_graph is None:
                raise RuntimeError("Re-compile after restart: no 'compiled' variable")
            _thread_id = f"{org_id}:{job_id}" if org_id else job_id
            config = {"configurable": {"thread_id": _thread_id}}
            skip = {"input", "output", "annotation"}
            trackable = [n["id"] for n in spec.get("nodes", []) if n.get("type") not in skip]
            _lg_runtime_state[job_id] = {
                "compiled_graph": compiled_graph,
                "lg_config": config,
                "trackable": trackable,
            }

        loop = asyncio.get_running_loop()
        emit_cb = _make_emit_cb(job_id, loop, _job_session)
        ctx = contextvars.copy_context()

        try:
            final_state = await loop.run_in_executor(
                None,
                cast(Any, ctx.run),
                _stream_graph,
                job_id,
                compiled_graph,
                Command(resume=resume_payload),
                config,
                trackable or [],
                emit_cb,
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
            await _job_update(job_id, db, status="done", result=output, ended_at=datetime.now(UTC))

        _lg_runtime_state.pop(job_id, None)

    except Exception as exc:
        async with _job_session() as db:
            await _mark_error_nodes(job_id, db, error_message=str(exc))
            await _job_update(job_id, db, status="error", error=str(exc), ended_at=datetime.now(UTC))
        _lg_runtime_state.pop(job_id, None)


# ─── Routes ───────────────────────────────────────────────────────────────────


@router.post("", status_code=202)
@limiter.limit("20/minute")
async def run_flow(
    request: Request,
    req: RunRequest,
    background: BackgroundTasks,
    runtime: str | None = Query(default=None),
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_session),
    org: Org = Depends(_current_org),
):
    spec = req.spec
    inputs = req.inputs  # user-supplied initial state values (e.g. {"topic": "photosynthesis"})
    _validate_spec(spec)

    # P-PC — reject unknown process_concept_id early (INV-PC-04: hard error)
    harness_meta = spec.get("harness_meta") or {}
    pc_id = harness_meta.get("process_concept_id")
    if pc_id and _concept_registry is not None and _ProcessConceptNotFoundError is not None:
        try:
            _concept_registry.load(pc_id)
        except _ProcessConceptNotFoundError:
            raise HTTPException(
                status_code=400,
                detail=f"process_concept_id {pc_id!r} is not registered. "
                "Check available concepts at GET /run/concepts.",
            ) from None

    spec = await resolve_prompts(spec, org)

    if not runtime:
        runtime = spec.get("runtime_hints", {}).get("preferred_adapter", "langgraph")
    runtime = runtime.lower()

    if runtime not in {"crewai", "langgraph", "mastra", "microsoft_agent_framework"}:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Runtime '{runtime}' is not yet executable. "
                "Supported: crewai, langgraph, mastra, microsoft_agent_framework"
            ),
        )

    await _evict_stale_jobs(db)

    job_id = str(uuid.uuid4())
    org_id = str(org.id) if org else None
    await _jobs_create(job_id, str(user.id), runtime, db, org_id=org_id)

    if runtime == "langgraph":
        background.add_task(_run_langgraph, job_id, spec, org_id, inputs)
    elif runtime == "mastra":
        background.add_task(_run_mastra, job_id, spec, org_id, inputs)
    elif runtime == "microsoft_agent_framework":
        background.add_task(_run_maf, job_id, spec, org_id, inputs)
    else:
        background.add_task(_run_crewai, job_id, spec, org_id, inputs)

    return {"job_id": job_id, "status": "queued", "runtime": runtime}


@_lf_observe(name="mastra-flow-resume", as_type="chain")
async def _resume_mastra(job_id: str, resume_payload: dict, org_id: str | None = None) -> None:
    """Resume a suspended Mastra HITL job by forwarding the payload to the runner."""
    async with _job_session() as db:
        job = await _jobs_get(job_id, db)
        hitl_state = (job.hitl_state if job else None) or {}
        step_id = hitl_state.get("node_id", "")
        await _job_update(job_id, db, status="running", ended_at=None)

    payload = {
        "step_id": step_id,
        "resume_data": resume_payload,
    }
    async with _httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{MASTRA_RUNNER_URL}/jobs/{job_id}/resume",
            json=payload,
            headers=_mastra_headers(),
        )
    if resp.status_code not in (200, 202):
        async with _job_session() as db:
            await _job_update(
                job_id,
                db,
                status="error",
                error=f"Mastra runner resume failed: HTTP {resp.status_code} — {resp.text[:200]}",
                ended_at=datetime.now(UTC),
            )
        return

    # Re-enter the poll loop to track the resumed run
    from asyncio import sleep as _sleep

    sent_events = 0  # events already stored; runner resets its own counter
    for _ in range(int(MASTRA_RUNNER_TIMEOUT / MASTRA_POLL_INTERVAL)):
        await _sleep(MASTRA_POLL_INTERVAL)
        async with _httpx.AsyncClient(timeout=10) as client:
            poll = await client.get(
                f"{MASTRA_RUNNER_URL}/jobs/{job_id}",
                headers=_mastra_headers(),
            )
        if poll.status_code != 200:
            break
        data = poll.json()
        runner_events = data.get("node_events", [])
        new_events = runner_events[sent_events:]
        if new_events:
            async with _job_session() as db:
                for ev in new_events:
                    await _emit(job_id, ev["node_id"], ev["status"], db, ev.get("ms"), ev.get("tokens"))
            sent_events += len(new_events)

        runner_status = data.get("status", "running")
        if runner_status == "done":
            result = data.get("result", "")
            async with _job_session() as db:
                await _job_update(job_id, db, status="done", result=result, ended_at=datetime.now(UTC))
            return
        if runner_status == "suspended":
            hitl = data.get("hitl_state", {}) or {}
            node_id = hitl.get("node_id", "unknown")
            async with _job_session() as db:
                await _emit(job_id, node_id, "paused", db)
                await _job_update(job_id, db, status="paused", hitl_state=hitl, ended_at=datetime.now(UTC))
            return
        if runner_status == "error":
            error = data.get("error", "Unknown error after resume")
            async with _job_session() as db:
                await _mark_error_nodes(job_id, db, error_message=error)
                await _job_update(job_id, db, status="error", error=error, ended_at=datetime.now(UTC))
            return


@router.post("/{job_id}/resume", status_code=202)
@limiter.limit("10/minute")
async def resume_flow(
    request: Request,
    job_id: str,
    req: ResumeRequest,
    background: BackgroundTasks,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_session),
):
    job = await _jobs_get_owned(job_id, str(user.id), db)
    if job.status != "paused":
        raise HTTPException(status_code=409, detail=f"Job is '{job.status}', not paused")
    if job.runtime not in ("langgraph", "microsoft_agent_framework", "mastra"):
        raise HTTPException(status_code=400, detail=f"Runtime '{job.runtime}' does not support HITL resume")

    if job.runtime == "mastra":
        background.add_task(_resume_mastra, job_id, req.payload, str(job.org_id) if job.org_id else None)
    elif job.runtime == "microsoft_agent_framework":
        background.add_task(_resume_maf, job_id, req.payload, req.spec, str(job.org_id) if job.org_id else None)
    else:
        background.add_task(_resume_langgraph, job_id, req.payload, req.spec, str(job.org_id) if job.org_id else None)
    return {"job_id": job_id, "status": "running"}


@router.get("/{job_id}", response_model=JobStatusResponse)
async def job_status(
    job_id: str,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_session),
):
    job = await _jobs_get_owned(job_id, str(user.id), db)
    return {
        "job_id": job.id,
        "status": job.status,
        "runtime": job.runtime,
        "started_at": job.started_at,
        "ended_at": job.ended_at,
        "result": job.result,
        "error": job.error,
        "node_events": job.node_events or [],
        "hitl_state": job.hitl_state,
        "trace_id": job.trace_id,
        "trace_url": job.trace_url,
    }


# ─── Process concept endpoints (P-PC) ────────────────────────────────────────


@router.get("/concepts", status_code=200)
async def list_concepts(
    user: User = Depends(current_user),
):
    """Return a list of all registered process concept IDs.

    Returns an empty list when the concept registry is unavailable.
    """
    if _concept_registry is None:
        return {"concepts": []}
    return {"concepts": _concept_registry.list_available()}


# ─── Harness state endpoints (P0.6) ──────────────────────────────────────────


class HarnessStateUpdateRequest(BaseModel):
    state: dict = {}


@router.get("/{job_id}/harness-state")
async def get_harness_state(
    job_id: str,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_session),
):
    """Return the full harness run state for a job.

    Returns 404 for non-harness runs — no empty-state response is leaked.
    """
    from harness.state_store import load as _harness_load

    job = await _jobs_get_owned(job_id, str(user.id), db)
    if not job.is_harness_run:
        raise HTTPException(status_code=404, detail="No harness state for this run")

    state = await _harness_load(job_id, db)
    if state is None:
        raise HTTPException(status_code=404, detail="No harness state for this run")

    return state.to_dict()


@router.put("/{job_id}/harness-state", status_code=200)
async def put_harness_state(
    job_id: str,
    req: HarnessStateUpdateRequest,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_session),
):
    """Upsert harness run state for a job.

    Merges the provided partial state dict with any existing state, then
    persists. Marks the job as a harness run on first write.
    """
    from harness.state_store import HarnessRunState
    from harness.state_store import load as _harness_load
    from harness.state_store import save as _harness_save

    await _jobs_get_owned(job_id, str(user.id), db)

    existing = await _harness_load(job_id, db)
    if existing is None:
        existing = HarnessRunState(run_id=job_id)

    existing_dict = existing.to_dict()
    existing_dict.update(req.state)
    merged = HarnessRunState.from_dict(job_id, existing_dict)

    await _harness_save(job_id, merged, db)

    return {"job_id": job_id, "saved": True}


# ─── Escalation endpoints (P7.3) ─────────────────────────────────────────────


class EscalationRespondRequest(BaseModel):
    clarification: dict = {}


@router.post("/{job_id}/escalation/respond", status_code=200)
async def respond_to_escalation(
    job_id: str,
    req: EscalationRespondRequest,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_session),
):
    """Post a human clarification response to a paused (escalated) harness run.

    Writes the clarification payload to harness_run_state.pending_clarification.
    On the next run_one_iteration() call, await_clarification() retrieves it and
    the constraint change propagation path (P7.2) handles the update, resuming
    the run without a restart.

    Returns 404 if no harness state exists for the job.
    Returns 409 if the run is not currently in an escalated state.
    """
    from harness.state_store import load as _harness_load
    from harness.state_store import save as _harness_save

    job = await _jobs_get_owned(job_id, str(user.id), db)
    if not job.is_harness_run:
        raise HTTPException(status_code=404, detail="No harness state for this run")

    state = await _harness_load(job_id, db)
    if state is None:
        raise HTTPException(status_code=404, detail="No harness state for this run")

    if not state.escalation_pending:
        raise HTTPException(status_code=409, detail="Run is not currently escalated")

    payload = dict(req.clarification)
    payload.setdefault("update_type", "clarification")
    state.pending_clarification = payload

    await _harness_save(job_id, state, db)

    return {"job_id": job_id, "clarification_posted": True}
