"""
itsharness — adapter server  v0.7.0  (Phase 3 complete)

Endpoints
  GET  /health                → adapter status
  GET  /runtimes              → list supported runtimes
  POST /compile               → codegen (auth required)
  POST /compile?runtime=X     → explicit runtime override

  POST /auth/register         → create account, returns JWT
  POST /auth/login            → login, returns JWT
  POST /auth/logout           → revoke current JWT (jti → Redis blocklist)
  GET  /auth/me               → current user info

  GET  /flows                 → list user's flows (paginated)
  POST /flows                 → save / upsert flow (auto-versions)
  GET  /flows/{id}            → current spec
  DELETE /flows/{id}          → delete flow
  GET  /flows/{id}/versions   → version history (paginated)
  POST /flows/{id}/versions/{ver_id}/restore → restore version

  POST /flows/{id}/invoke     → synchronous REST execution (deployed flows)

  POST /run                   → execute flow (async job)
  GET  /run/{job_id}          → job status + result
  POST /run/{job_id}/resume   → resume HITL-paused job

  POST   /teams                              → create team
  GET    /teams                              → list caller's teams
  GET    /teams/{team_id}                    → team detail + members
  PATCH  /teams/{team_id}                    → rename team (admin)
  DELETE /teams/{team_id}                    → delete team (admin)
  POST   /teams/{team_id}/members            → invite member (admin)
  PATCH  /teams/{team_id}/members/{user_id}  → change role (admin)
  DELETE /teams/{team_id}/members/{user_id}  → remove member (admin)
  POST   /teams/{team_id}/flows/{flow_id}    → share flow with team (admin)
  DELETE /teams/{team_id}/flows/{flow_id}    → unshare flow (admin)
  GET    /teams/{team_id}/flows              → list flows shared with team

  POST /eval/score            → write LLM-as-judge score to a Langfuse trace
  POST /eval/feedback         → user thumbs-up/down signal (Annotation Queue)
  GET  /eval/templates        → list active LLM-as-judge evaluator configs
  GET  /eval/scores           → fetch scores for a trace (canvas quality badges)

  GET  /prompts               → list Langfuse-managed prompts (for canvas picker)
  GET  /prompts/{name}        → versions + preview for a specific prompt

  GET  /.well-known/agent.json              → default AgentCard (public)
  GET  /.well-known/agent/{flow_id}.json    → AgentCard for specific flow (public)
  GET  /.well-known/mcp/{flow_id}.json      → MCP tool manifest (public)
  POST /a2a/{flow_id}/tasks/send            → create + start A2A task
  GET  /a2a/{flow_id}/tasks/{task_id}       → A2A task status
  GET  /a2a/{flow_id}/tasks/{task_id}/events → SSE stream of task events
  POST   /deploy/a2a/{flow_id}              → deploy flow as A2A agent only
  DELETE /deploy/a2a/{flow_id}              → undeploy A2A only
  POST   /deploy/{flow_id}                  → unified one-click deploy (REST+MCP+A2A)
  DELETE /deploy/{flow_id}                  → unified undeploy
  GET    /share/{flow_id}                   → shareable deployment metadata (public)

  GET  /marketplace                         → list community components (public)
  GET  /marketplace/{slug}                  → component detail (public)
  POST /marketplace                         → publish a component (auth required)
  POST /marketplace/{slug}/install          → install component, returns node_spec
"""

import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

if os.getenv("DOTENV_LOAD", "true").lower() not in ("false", "0", "no"):
    try:
        from dotenv import load_dotenv

        _env_path = Path(__file__).parent.parent / ".env"
        if _env_path.exists():
            load_dotenv(_env_path, override=False)
    except ImportError:
        pass

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

_REQUIRED_SECRETS: dict[str, str] = {
    "JWT_SECRET": "Generate with: openssl rand -base64 32",
}
_INSECURE_SUBSTRINGS = (
    "REPLACE_WITH_REAL_SECRET",
    "REPLACE_WITH_REAL_PASSWORD",
    "REPLACE_WITH_64_HEX_CHARS",
    "REPLACE_ME",
    "change-me-in-production",
)


def _is_insecure(value: str) -> bool:
    if not value:
        return True
    return any(marker in value for marker in _INSECURE_SUBSTRINGS)


_startup_errors: list[str] = []
for _var, _hint in _REQUIRED_SECRETS.items():
    _val = os.getenv(_var, "")
    if _is_insecure(_val):
        _startup_errors.append(f"  {_var} is not set or insecure. {_hint}")

if _startup_errors:
    print("FATAL: required secrets missing or insecure:\n" + "\n".join(_startup_errors), file=sys.stderr)
    sys.exit(1)

for _opt_var in ("LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"):
    _opt_val = os.getenv(_opt_var, "")
    if not _opt_val:
        print(f"[itsharness] WARNING: {_opt_var} not set — Langfuse tracing disabled.", file=sys.stderr)
    elif _is_insecure(_opt_val):
        print(
            f"[itsharness] WARNING: {_opt_var} is still at its placeholder value. "
            "Langfuse will boot with a publicly-known key — replace it before exposing "
            "this stack to the network.",
            file=sys.stderr,
        )

from a2a_api import router_deploy as a2a_deploy_router  # noqa: E402
from a2a_api import router_tasks as a2a_tasks_router  # noqa: E402
from a2a_api import router_well_known as a2a_wk_router  # noqa: E402
from auth import current_user  # noqa: E402
from auth import router as auth_router  # noqa: E402
from crewai_adapter import compile_crewai  # noqa: E402
from db import User, init_db  # noqa: E402
from deploy_api import router_deploy as deploy_router  # noqa: E402
from deploy_api import router_invoke as deploy_invoke_router  # noqa: E402
from deploy_api import router_share as deploy_share_router  # noqa: E402
from deploy_api import router_well_known as deploy_wk_router  # noqa: E402
from eval_api import router as eval_router  # noqa: E402
from eval_api import seed_eval_templates  # noqa: E402
from flows_api import router as flows_router  # noqa: E402
from langgraph_adapter import compile_langgraph  # noqa: E402
from marketplace_api import router as marketplace_router  # noqa: E402
from marketplace_api import seed_marketplace  # noqa: E402
from mastra_adapter import compile_mastra  # noqa: E402
from org_context import Org  # noqa: E402
from org_context import current_org as _current_org_dep  # noqa: E402
from orgs_api import router as orgs_router  # noqa: E402
from prompt_resolver import resolve_prompts  # noqa: E402
from prompts_api import router as prompts_router  # noqa: E402
from rate_limit import limiter  # noqa: E402
from run_api import router as run_router  # noqa: E402
from sso_auth import router_scim, router_sso, router_token  # noqa: E402
from teams_api import router as teams_router  # noqa: E402
from validate import validate_spec as _validate_spec  # noqa: E402


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    await seed_eval_templates()
    await seed_marketplace()
    yield
    if os.getenv("TESTING") != "true":
        from redis_client import close_pool

        await close_pool()


app = FastAPI(title="itsharness-adapter", version="0.7.0", lifespan=lifespan)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)  # type: ignore[arg-type]


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["X-XSS-Protection"] = "0"

    if not request.url.path.startswith("/auth") and not request.url.path.startswith("/run"):
        response.headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'"

    return response


MAX_BODY_BYTES = int(os.getenv("MAX_BODY_BYTES", str(1 * 1024 * 1024)))


@app.middleware("http")
async def limit_body_size(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if content_length and int(content_length) > MAX_BODY_BYTES:
        return JSONResponse(status_code=413, content={"detail": f"Request body too large (max {MAX_BODY_BYTES} bytes)"})
    if not content_length and request.method in ("POST", "PUT", "PATCH"):
        body_so_far = b""
        async for chunk in request.stream():
            body_so_far += chunk
            if len(body_so_far) > MAX_BODY_BYTES:
                return JSONResponse(
                    status_code=413, content={"detail": f"Request body too large (max {MAX_BODY_BYTES} bytes)"}
                )
        body_consumed = False

        async def _receive():
            nonlocal body_consumed
            if not body_consumed:
                body_consumed = True
                return {"type": "http.request", "body": body_so_far, "more_body": False}
            return {"type": "http.disconnect"}

        request = Request(request.scope, receive=_receive)
    return await call_next(request)


_cors_origins_env = os.getenv("CORS_ORIGINS", "http://localhost:3000,http://canvas:3000")
_cors_origins = [o.strip() for o in _cors_origins_env.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware, allow_origins=_cors_origins, allow_credentials=True, allow_methods=["*"], allow_headers=["*"]
)

app.include_router(auth_router)
app.include_router(router_sso)  # GET /auth/sso/config, GET /auth/sso/login, GET /auth/sso/callback
app.include_router(router_token)  # POST /auth/token/refresh
app.include_router(router_scim)  # GET|PATCH /scim/v2/Users
app.include_router(flows_router)
app.include_router(run_router)
app.include_router(teams_router)
app.include_router(eval_router)
app.include_router(prompts_router)
app.include_router(a2a_wk_router)
app.include_router(a2a_tasks_router)
# A2A-only deploy must be mounted before the unified deploy router so
# /deploy/a2a/{flow_id} is matched before /deploy/{flow_id}.
app.include_router(a2a_deploy_router)
app.include_router(deploy_router)
app.include_router(deploy_wk_router)
app.include_router(deploy_share_router)
app.include_router(deploy_invoke_router)
app.include_router(marketplace_router)
app.include_router(orgs_router)


SUPPORTED_RUNTIMES = {
    "langgraph": {"status": "full", "note": "Python codegen + execution. All 14 node types.", "executable": True},
    "crewai": {"status": "full", "note": "Python codegen + execution. All RFC stubs resolved.", "executable": True},
    "mastra": {"status": "full", "note": "TypeScript codegen + execution via Node.js sidecar.", "executable": True},
}


class CompileRequest(BaseModel):
    spec: dict


class CompileResponse(BaseModel):
    runtime: str
    code: str
    warnings: list[str]


@app.get("/health")
def health():
    return {
        "status": "ok",
        "adapter": "itsharness",
        "version": "0.7.0",
        "langfuse": os.getenv("LANGFUSE_BASE_URL", "http://langfuse:3000"),
    }


@app.get("/runtimes")
def runtimes():
    return {"runtimes": SUPPORTED_RUNTIMES}


@app.post("/compile", response_model=CompileResponse)
@limiter.limit("30/minute")
async def compile_flow(
    request: Request,
    req: CompileRequest,
    runtime: str | None = Query(default=None),
    user: User = Depends(current_user),
    org: "Org" = Depends(_current_org_dep),
) -> CompileResponse:
    spec = req.spec
    _validate_spec(spec)

    # Resolve prompt_ref → inject prompt_template for nodes using Langfuse-managed
    # prompts.  Must run after validate_spec() and before adapter codegen so every
    # adapter sees a fully-populated spec.  No-op in TESTING=true.
    spec = await resolve_prompts(spec, org)

    if not runtime:
        runtime = spec.get("runtime_hints", {}).get("preferred_adapter", "langgraph")
    runtime = runtime.lower()

    if runtime not in SUPPORTED_RUNTIMES:
        raise HTTPException(
            status_code=400, detail=f"Unknown runtime '{runtime}'. Supported: {list(SUPPORTED_RUNTIMES)}"
        )

    if runtime == "crewai":
        try:
            code, warnings = compile_crewai(spec)
        except Exception as exc:
            raise HTTPException(status_code=422, detail=f"CrewAI codegen failed: {exc}") from exc
        return CompileResponse(runtime="crewai", code=code, warnings=warnings)

    if runtime == "mastra":
        try:
            code, warnings = compile_mastra(spec)
        except Exception as exc:
            raise HTTPException(status_code=422, detail=f"Mastra codegen failed: {exc}") from exc
        return CompileResponse(runtime="mastra", code=code, warnings=warnings)

    if runtime == "langgraph":
        try:
            code, warnings = compile_langgraph(spec)
        except Exception as exc:
            raise HTTPException(status_code=422, detail=f"LangGraph codegen failed: {exc}") from exc
        return CompileResponse(runtime="langgraph", code=code, warnings=warnings)

    raise HTTPException(status_code=400, detail=f"Unknown runtime '{runtime}'. Supported: {list(SUPPORTED_RUNTIMES)}")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)  # noqa: S104
