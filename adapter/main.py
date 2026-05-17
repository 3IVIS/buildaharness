"""
itsharness — adapter server  v0.4.0

Endpoints
  GET  /health                → adapter status
  GET  /runtimes              → list supported runtimes
  POST /compile               → codegen (auth required)
  POST /compile?runtime=X     → explicit runtime override

  POST /auth/register         → create account, returns JWT
  POST /auth/login            → login, returns JWT
  GET  /auth/me               → current user info

  GET  /flows                 → list user's flows (paginated)
  POST /flows                 → save / upsert flow (auto-versions)
  GET  /flows/{id}            → current spec
  DELETE /flows/{id}          → delete flow
  GET  /flows/{id}/versions   → version history (paginated)
  POST /flows/{id}/versions/{ver_id}/restore → restore version

  POST /run                   → execute flow (async job)
  GET  /run/{job_id}          → job status + result
  POST /run/{job_id}/resume   → resume HITL-paused job
"""
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

# ── Load .env before anything else reads os.environ ──────────────────────────
# python-dotenv is a dev/local convenience — it loads the project-root .env so
# you can run `python main.py` without manually exporting every secret first.
# In Docker, env vars come from docker-compose.yml and dotenv is a no-op.
# Override: set DOTENV_PATH to point at a different file, or DOTENV_LOAD=false
# to skip loading entirely.
if os.getenv("DOTENV_LOAD", "true").lower() not in ("false", "0", "no"):
    try:
        from dotenv import load_dotenv
        # Walk up from adapter/ to find the project root .env
        _env_path = Path(__file__).parent.parent / ".env"
        if _env_path.exists():
            load_dotenv(_env_path, override=False)  # override=False: shell vars win
    except ImportError:
        pass  # python-dotenv not installed — silently skip (Docker path)

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

# ── Startup secret validation ─────────────────────────────────────────────────
# Run BEFORE importing any local module that reads env vars at import time
# (auth.py reads JWT_SECRET at module level). This ensures operators see the
# clean FATAL message rather than a raw Python RuntimeError traceback.
#
# Fix #2: router imports moved to AFTER this block so auth.py's module-level
# RuntimeError can never fire before our clean error message does.

_REQUIRED_SECRETS: dict[str, str] = {
    "JWT_SECRET": "Generate with: openssl rand -base64 32",
}
# Fix #12: expanded to cover every placeholder string used in .env.example.
# Fix #26: switched from exact-set membership to substring matching so that
# prefixed placeholders like "pk-lf-REPLACE_ME" and "sk-lf-REPLACE_ME" are
# caught too.  The old exact-match set let those values through the guard,
# allowing the Langfuse stack to boot with a known default key that anyone
# who has read the .env.example could use to authenticate.
_INSECURE_SUBSTRINGS = (
    "REPLACE_WITH_REAL_SECRET",
    "REPLACE_WITH_REAL_PASSWORD",
    "REPLACE_WITH_64_HEX_CHARS",
    "REPLACE_ME",
    "change-me-in-production",
)


def _is_insecure(value: str) -> bool:
    """Return True if value is empty or contains any known placeholder substring."""
    if not value:
        return True
    return any(marker in value for marker in _INSECURE_SUBSTRINGS)


_startup_errors: list[str] = []
for _var, _hint in _REQUIRED_SECRETS.items():
    _val = os.getenv(_var, "")
    if _is_insecure(_val):
        _startup_errors.append(f"  {_var} is not set or insecure. {_hint}")

if _startup_errors:
    print("FATAL: required secrets missing or insecure:\n" + "\n".join(_startup_errors),
          file=sys.stderr)
    sys.exit(1)

# Warn (don't fail) for optional observability secrets.
# Fix #26: also warn when the Langfuse keys are still at their .env.example
# placeholder values ("pk-lf-REPLACE_ME" / "sk-lf-REPLACE_ME").  These are
# valid non-empty strings so the old guard missed them, letting Langfuse boot
# with a publicly-known default key.
for _opt_var in ("LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"):
    _opt_val = os.getenv(_opt_var, "")
    if not _opt_val:
        print(f"[itsharness] WARNING: {_opt_var} not set — Langfuse tracing disabled.",
              file=sys.stderr)
    elif _is_insecure(_opt_val):
        print(
            f"[itsharness] WARNING: {_opt_var} is still at its placeholder value. "
            "Langfuse will boot with a publicly-known key — replace it before exposing "
            "this stack to the network.",
            file=sys.stderr,
        )

# ── Router imports (after secret validation) ──────────────────────────────────
# Fix #2: keeping imports here means auth.py's module-level JWT_SECRET check
# only runs once the env has already been validated above.
from rate_limit import limiter                   # noqa: E402
from db         import init_db                   # noqa: E402
from auth       import router as auth_router, current_user  # noqa: E402
from db         import User                      # noqa: E402
# validate.py holds validate_spec, used here (compile) and in flows_api + run_api.
# Keeping it in its own module breaks the circular import that previously existed
# between flows_api -> main -> flows_api.
# Fix #25 (shadow): the local _validate_spec wrapper defined at the bottom of this
# file was removed — it shadowed this import without adding any value.
from validate   import validate_spec as _validate_spec  # noqa: E402
from flows_api  import router as flows_router    # noqa: E402
from run_api    import router as run_router      # noqa: E402
from crewai_adapter    import compile_crewai     # noqa: E402
from mastra_adapter    import compile_mastra     # noqa: E402
from langgraph_adapter import compile_langgraph  # noqa: E402


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


app = FastAPI(title="itsharness-adapter", version="0.4.0", lifespan=lifespan)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)  # type: ignore[arg-type]


# ── Security response headers ─────────────────────────────────────────────────
@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"]         = "DENY"
    response.headers["Referrer-Policy"]          = "strict-origin-when-cross-origin"
    response.headers["X-XSS-Protection"]         = "0"
    # Fix #9: Content-Security-Policy was missing. The adapter serves JSON only;
    # 'none' for all directives is safe and explicitly disallows any rendering.
    response.headers["Content-Security-Policy"]  = "default-src 'none'; frame-ancestors 'none'"
    return response


# ── Fix #6 (body size): reject oversized request bodies ──────────────────────
# A multi-MB spec POSTed to /compile or /run triggers expensive codegen.
# Reject anything over 1 MB before it reaches route handlers.
MAX_BODY_BYTES = int(os.getenv("MAX_BODY_BYTES", str(1 * 1024 * 1024)))  # default 1 MB

@app.middleware("http")
async def limit_body_size(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if content_length and int(content_length) > MAX_BODY_BYTES:
        from fastapi.responses import JSONResponse
        return JSONResponse(
            status_code=413,
            content={"detail": f"Request body too large (max {MAX_BODY_BYTES} bytes)"},
        )
    # Also handle chunked transfer encoding (no Content-Length header).
    # Buffer the body so we can both size-check it and re-make it available to
    # route handlers via a proper ASGI receive callable.
    if not content_length and request.method in ("POST", "PUT", "PATCH"):
        body_so_far = b""
        async for chunk in request.stream():
            body_so_far += chunk
            if len(body_so_far) > MAX_BODY_BYTES:
                from fastapi.responses import JSONResponse
                return JSONResponse(
                    status_code=413,
                    content={"detail": f"Request body too large (max {MAX_BODY_BYTES} bytes)"},
                )
        # Re-inject the buffered body as a proper ASGI receive callable.
        # ASGI receive must return dicts with {'type': 'http.request', 'body': bytes, 'more_body': bool}.
        body_consumed = False

        async def _receive():
            nonlocal body_consumed
            if not body_consumed:
                body_consumed = True
                return {"type": "http.request", "body": body_so_far, "more_body": False}
            # Subsequent calls after body is consumed: signal disconnect.
            return {"type": "http.disconnect"}

        request = Request(request.scope, receive=_receive)
    return await call_next(request)


# ── CORS ──────────────────────────────────────────────────────────────────────
_cors_origins_env = os.getenv("CORS_ORIGINS", "http://localhost:3000,http://canvas:3000")
_cors_origins = [o.strip() for o in _cors_origins_env.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router)
app.include_router(flows_router)
app.include_router(run_router)


SUPPORTED_RUNTIMES = {
    "langgraph": {
        "status":    "full",
        "note":      "Python codegen + execution. All 14 node types.",
        "executable": True,
    },
    "crewai": {
        "status":    "full",
        "note":      "Python codegen + execution. All RFC stubs resolved.",
        "executable": True,
    },
    "mastra": {
        "status":    "codegen-only",
        "note":      "TypeScript codegen only. Execution requires a separate Node.js runtime.",
        "executable": False,
    },
}


class CompileRequest(BaseModel):
    spec: dict

class CompileResponse(BaseModel):
    runtime:  str
    code:     str
    warnings: list[str]


@app.get("/health")
def health():
    return {
        "status":   "ok",
        "adapter":  "itsharness",
        "version":  "0.4.0",
        "langfuse": os.getenv("LANGFUSE_BASE_URL", "http://langfuse:3000"),
    }


@app.get("/runtimes")
def runtimes():
    return {"runtimes": SUPPORTED_RUNTIMES}


@app.post("/compile", response_model=CompileResponse)
@limiter.limit("30/minute")
async def compile_flow(
    request: Request,
    req:     CompileRequest,
    runtime: str | None = Query(default=None),
    user:    User = Depends(current_user),
) -> CompileResponse:
    spec = req.spec
    _validate_spec(spec)

    if not runtime:
        runtime = spec.get("runtime_hints", {}).get("preferred_adapter", "langgraph")
    runtime = runtime.lower()

    if runtime not in SUPPORTED_RUNTIMES:
        raise HTTPException(status_code=400,
                            detail=f"Unknown runtime '{runtime}'. Supported: {list(SUPPORTED_RUNTIMES)}")

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

    raise HTTPException(
        status_code=400,
        detail=f"Unknown runtime '{runtime}'. Supported: {list(SUPPORTED_RUNTIMES)}",
    )


if __name__ == "__main__":
    import uvicorn
    # reload=True requires an import string, not the app object — uvicorn needs
    # to re-import the module on file changes and cannot do that with an object ref.
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
