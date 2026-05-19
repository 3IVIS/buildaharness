"""
Online eval — Langfuse LLM-as-judge integration.

POST /eval/score        — write an LLM-as-judge score to a Langfuse trace/observation
POST /eval/feedback     — user thumbs signal (+1/-1/0); surfaces in Annotation Queue
GET  /eval/templates    — list active LLM-as-judge evaluator configs from Langfuse
GET  /eval/scores       — fetch scores attached to a trace (for canvas quality badges)

seed_eval_templates()   — called from lifespan in main.py; idempotently registers
                          three evaluator configs (faithfulness, task_completion,
                          hallucination) on first boot when LANGFUSE_EVAL_ENABLED=true.

TESTING=true skips all real Langfuse calls so the CI suite never needs a live
Langfuse instance.  Endpoints still validate inputs and return correct HTTP status.
"""
import os
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from auth import current_user
from db import User

# ── Langfuse client ───────────────────────────────────────────────────────────
# get_client() returns the process-wide Langfuse singleton.  The client is only
# usable when LANGFUSE_PUBLIC_KEY is set; every route that calls it guards on
# _LANGFUSE_ENABLED first and falls back gracefully when Langfuse is absent.
try:
    from langfuse import get_client as _lf_get_client
    _LANGFUSE_ENABLED = bool(os.getenv("LANGFUSE_PUBLIC_KEY"))
except ImportError:
    _LANGFUSE_ENABLED = False

    def _lf_get_client():  # type: ignore[misc]
        return None


# Import the in-memory job store to resolve trace_id from job_id for feedback.
# No circular dependency: run_api never imports eval_api.
from run_api import _jobs  # noqa: E402 (after stdlib/third-party)

_LANGFUSE_BASE_URL  = os.getenv("LANGFUSE_BASE_URL",  "http://langfuse:3000")
_LANGFUSE_SECRET_KEY = os.getenv("LANGFUSE_SECRET_KEY", "")
_LANGFUSE_PUBLIC_KEY = os.getenv("LANGFUSE_PUBLIC_KEY", "")

router = APIRouter(prefix="/eval", tags=["eval"])


# ── Pydantic schemas ──────────────────────────────────────────────────────────

class ScoreRequest(BaseModel):
    trace_id:       str
    observation_id: str | None = None
    name:           str
    value:          float
    comment:        str | None = None


class FeedbackRequest(BaseModel):
    job_id:  str
    value:   int   # 1 = thumbs up,  -1 = thumbs down,  0 = neutral retraction
    comment: str | None = None


# ── HTTP client for Langfuse REST API ─────────────────────────────────────────

def _lf_http() -> httpx.AsyncClient:
    """Authenticated async httpx client for the Langfuse HTTP API.

    Uses Basic auth: public_key:secret_key as required by Langfuse.
    """
    return httpx.AsyncClient(
        base_url=_LANGFUSE_BASE_URL,
        auth=(_LANGFUSE_PUBLIC_KEY, _LANGFUSE_SECRET_KEY),
        timeout=10.0,
    )


# ── Routes ────────────────────────────────────────────────────────────────────

@router.post("/score", status_code=204)
async def write_score(
    req:  ScoreRequest,
    user: User = Depends(current_user),
) -> None:
    """Write a programmatic score (e.g. from an LLM-as-judge background task) to
    a Langfuse trace or child observation.

    TESTING=true / Langfuse absent → 204 no-op (no Langfuse call).
    """
    if os.getenv("TESTING") == "true" or not _LANGFUSE_ENABLED:
        return

    try:
        lf = _lf_get_client()
        lf.score(
            trace_id=req.trace_id,
            observation_id=req.observation_id,
            name=req.name,
            value=req.value,
            comment=req.comment,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Langfuse score write failed: {exc}",
        ) from exc


@router.post("/feedback", status_code=204)
async def submit_feedback(
    req:  FeedbackRequest,
    user: User = Depends(current_user),
) -> None:
    """Record a thumbs-up / thumbs-down signal for a completed run.

    Resolves the job → trace_id mapping from the in-memory job store, then
    writes a 'user_feedback' score to Langfuse.  The score name 'user_feedback'
    is the Langfuse convention that surfaces entries in the Annotation Queue UI
    automatically.

    Returns 204 on success or when Langfuse is unavailable — the UI should
    optimistically mark feedback as submitted either way.

    Error cases:
      422  value not in {1, -1, 0}
      404  job not found or caller does not own it
    """
    if req.value not in (1, -1, 0):
        raise HTTPException(status_code=422, detail="value must be 1, -1, or 0")

    job = _jobs.get(req.job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    # Enforce ownership with the same silent-404 pattern used by run_api — no
    # information leak about whether the job exists for other users.
    if job.get("user_id") != str(user.id):
        raise HTTPException(status_code=404, detail="Job not found")

    trace_id: str | None = job.get("trace_id")
    if not trace_id:
        # Job exists but has no Langfuse trace (Langfuse disabled or trace not
        # yet populated).  Return 204 — nothing to write, user's action recorded.
        return

    if os.getenv("TESTING") == "true" or not _LANGFUSE_ENABLED:
        return

    try:
        lf = _lf_get_client()
        lf.score(
            trace_id=trace_id,
            name="user_feedback",
            value=float(req.value),
            comment=req.comment,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Langfuse feedback write failed: {exc}",
        ) from exc


@router.get("/templates")
async def list_eval_templates(
    user: User = Depends(current_user),
) -> dict:
    """Proxy Langfuse GET /api/evals/configs.

    Returns the list of configured LLM-as-judge evaluators so the canvas knows
    which auto-scorers are active and can display their names in quality badge
    tooltips.  Returns an empty list when Langfuse is not configured.
    """
    if os.getenv("TESTING") == "true" or not _LANGFUSE_ENABLED:
        return {"data": [], "meta": {"total": 0}}

    async with _lf_http() as http:
        try:
            resp = await http.get("/api/evals/configs")
            resp.raise_for_status()
            return resp.json()
        except httpx.HTTPStatusError as exc:
            raise HTTPException(
                status_code=exc.response.status_code,
                detail=f"Langfuse API error: {exc.response.text}",
            ) from exc
        except Exception as exc:
            raise HTTPException(
                status_code=502,
                detail=f"Langfuse unreachable: {exc}",
            ) from exc


@router.get("/scores")
async def get_scores(
    trace_id: str = Query(..., description="Langfuse trace ID returned by GET /run/{job_id}"),
    user:     User = Depends(current_user),
) -> dict:
    """Fetch all scores attached to a Langfuse trace.

    Used by the canvas run poller after a job completes to populate per-node
    quality badge arcs on ExecBadge.  Scores are keyed by observationId; the
    canvas maps observationId → nodeId via the node_events observation map.

    Returns {"data": []} when Langfuse is unavailable — the canvas renders
    quality badges as no-ops rather than surfacing an error.
    """
    if os.getenv("TESTING") == "true" or not _LANGFUSE_ENABLED:
        return {"data": []}

    async with _lf_http() as http:
        try:
            resp = await http.get("/api/scores", params={"traceId": trace_id})
            resp.raise_for_status()
            return resp.json()
        except Exception:
            # Graceful degradation — quality badges are informational, not critical.
            return {"data": []}


# ── Eval template seeder ──────────────────────────────────────────────────────

# Three evaluator configs registered in Langfuse at startup.
# These use Langfuse's built-in LLM-as-judge evaluation pipeline:
# once registered, Langfuse automatically scores every new trace matching
# the filter criteria without any per-run code in the adapter.
_EVAL_TEMPLATES: list[dict[str, Any]] = [
    {
        "name":        "faithfulness",
        "prompt":      (
            "You are evaluating the faithfulness of an AI response. "
            "Score from 0 to 1 where 1 means the response is fully grounded "
            "in the provided context and 0 means it contains hallucinations.\n\n"
            "Context: {{input}}\nResponse: {{output}}\n\n"
            "Return ONLY a JSON object (no markdown): "
            "{\"score\": <float 0-1>, \"reasoning\": \"<one sentence>\"}."
        ),
        "vars":        ["input", "output"],
        "outputScore": "faithfulness",
    },
    {
        "name":        "task_completion",
        "prompt":      (
            "Evaluate whether the AI response fully completes the requested task. "
            "Score from 0 to 1 where 1 = task fully completed, 0 = task not completed.\n\n"
            "Task: {{input}}\nResponse: {{output}}\n\n"
            "Return ONLY a JSON object (no markdown): "
            "{\"score\": <float 0-1>, \"reasoning\": \"<one sentence>\"}."
        ),
        "vars":        ["input", "output"],
        "outputScore": "task_completion",
    },
    {
        "name":        "hallucination",
        "prompt":      (
            "Evaluate whether the AI response contains hallucinations "
            "(claims not grounded in the context or demonstrably false). "
            "Score from 0 to 1 where 0 = no hallucinations, 1 = severe hallucinations.\n\n"
            "Context: {{input}}\nResponse: {{output}}\n\n"
            "Return ONLY a JSON object (no markdown): "
            "{\"score\": <float 0-1>, \"reasoning\": \"<one sentence>\"}."
        ),
        "vars":        ["input", "output"],
        "outputScore": "hallucination",
    },
]


async def seed_eval_templates() -> None:
    """Register LLM-as-judge evaluator configs in Langfuse at adapter startup.

    Idempotent: a 409 Conflict response means the config already exists and
    is silently skipped.  Designed to be called once from the FastAPI lifespan
    so operators don't need to configure evaluators manually in the Langfuse UI.

    Gated on LANGFUSE_EVAL_ENABLED=true to avoid registering evaluators in
    environments where automated scoring is not wanted (e.g. dev laptops).

    No-op when:
      - TESTING=true          (CI — no live Langfuse)
      - LANGFUSE_PUBLIC_KEY   not set (Langfuse tracing disabled)
      - LANGFUSE_EVAL_ENABLED not set to "true"
    """
    if os.getenv("TESTING") == "true":
        return
    if not _LANGFUSE_ENABLED:
        return
    if os.getenv("LANGFUSE_EVAL_ENABLED", "false").lower() != "true":
        return

    async with _lf_http() as http:
        for template in _EVAL_TEMPLATES:
            try:
                resp = await http.post("/api/evals/configs", json=template)
                # 200/201 → created; 409 → already registered — both are fine.
                if resp.status_code not in (200, 201, 409):
                    print(
                        f"[itsharness] WARNING: eval template seeder — "
                        f"'{template['name']}' returned HTTP {resp.status_code}: {resp.text}",
                        flush=True,
                    )
                else:
                    action = "registered" if resp.status_code in (200, 201) else "already exists"
                    print(
                        f"[itsharness] eval template '{template['name']}' {action}.",
                        flush=True,
                    )
            except Exception as exc:
                # Don't crash the adapter if Langfuse is temporarily unreachable
                # at boot time — the seeder will run again on the next restart.
                print(
                    f"[itsharness] WARNING: eval template seeder — "
                    f"could not register '{template['name']}': {exc}",
                    flush=True,
                )
