"""
Tests for:
  - _validate_spec (structural checks + fn_ref allowlist)
  - POST /compile  (compile endpoint auth + routing)
  - _build_initial_state (Fix #22)
  - security headers (Fix #9)
"""
import copy
import pytest
from fastapi import HTTPException

from validate import validate_spec as _validate_spec, check_fn_ref as _check_fn_ref
from run_api import _build_initial_state
from tests.conftest import MINIMAL_SPEC


# ── _validate_spec unit tests ─────────────────────────────────────────────────

def test_validate_spec_ok():
    _validate_spec(MINIMAL_SPEC)  # must not raise


def test_validate_spec_missing_nodes():
    with pytest.raises(HTTPException) as exc:
        _validate_spec({"spec_version": "0.2.0", "id": "x", "edges": []})
    assert exc.value.status_code == 400


def test_validate_spec_empty_nodes():
    with pytest.raises(HTTPException) as exc:
        _validate_spec({**MINIMAL_SPEC, "nodes": []})
    assert exc.value.status_code == 400


def test_validate_spec_wrong_version():
    with pytest.raises(HTTPException) as exc:
        _validate_spec({**MINIMAL_SPEC, "spec_version": "0.1.0"})
    assert exc.value.status_code == 400
    assert "spec_version" in exc.value.detail


def test_validate_spec_no_input_node():
    spec = copy.deepcopy(MINIMAL_SPEC)
    spec["nodes"] = [n for n in spec["nodes"] if n["type"] != "input"]
    with pytest.raises(HTTPException) as exc:
        _validate_spec(spec)
    assert "input" in exc.value.detail


def test_validate_spec_no_output_node():
    spec = copy.deepcopy(MINIMAL_SPEC)
    spec["nodes"] = [n for n in spec["nodes"] if n["type"] != "output"]
    with pytest.raises(HTTPException) as exc:
        _validate_spec(spec)
    assert "output" in exc.value.detail


# ── fn_ref allowlist tests (Fix #3) ──────────────────────────────────────────

@pytest.mark.parametrize("valid_ref", [
    "my_module:transform",
    "my_pkg.sub.module:my_func",
    "transforms:join_reducer",
    "a:b",
    "@canvas/flows-rag/formatChunks",           # npm ref used in reference flows
    "@langchain/community/tools/TavilySearch",  # npm ref in tool registry
    "./local/path:fn",                          # local path ref
    "@scope/pkg",                               # bare npm package
])
def test_fn_ref_valid(valid_ref):
    _check_fn_ref(valid_ref, "test")  # must not raise


@pytest.mark.parametrize("bad_ref", [
    "../../../etc/passwd",          # path traversal
    "os.path:join; import os",      # shell injection via semicolon
    "__import__('os')",            # parentheses blocked
    "module:func with space",       # space is blocked
    "module:func`evil`",            # backtick blocked
    "module|pipe",                  # pipe blocked
    "module&chain",                 # ampersand blocked
    "$ENV_VAR",                     # dollar sign blocked
    "module:func:extra",            # multiple colons — could cause importlib failure
])
def test_fn_ref_invalid_pattern(bad_ref):
    """Ensure shell-injection and path-traversal attempts are rejected."""
    with pytest.raises(HTTPException) as exc:
        _check_fn_ref(bad_ref, "test fn_ref")
    assert exc.value.status_code == 400


@pytest.mark.asyncio
async def test_compile_fn_ref_injection_rejected(client, auth_headers):
    """End-to-end: crafted fn_ref with shell chars must be rejected at the compile endpoint."""
    spec = copy.deepcopy(MINIMAL_SPEC)
    spec["nodes"].append({
        "id": "transform-1",
        "type": "transform",
        "position": {"x": 150, "y": 0},
        "mode": "fn_ref",
        "fn_ref": "../../../etc/passwd",   # path traversal — blocked by new pattern
    })
    spec["edges"].append({
        "id": "e2", "type": "direct", "from": "input-1", "to": "transform-1",
    })
    r = await client.post("/compile", json={"spec": spec}, headers=auth_headers)
    assert r.status_code == 400
    assert "fn_ref" in r.json()["detail"]


# ── compile endpoint ──────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_compile_requires_auth(client):
    r = await client.post("/compile", json={"spec": MINIMAL_SPEC})
    assert r.status_code == 401  # FastAPI 0.115+: HTTPBearer returns 401 when no token


@pytest.mark.asyncio
async def test_compile_langgraph(client, auth_headers):
    r = await client.post(
        "/compile?runtime=langgraph",
        json={"spec": MINIMAL_SPEC},
        headers=auth_headers,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["runtime"] == "langgraph"
    assert "compiled" in body["code"]      # LangGraph output contains 'compiled'


@pytest.mark.asyncio
async def test_compile_unknown_runtime(client, auth_headers):
    r = await client.post(
        "/compile?runtime=unknown_runtime",
        json={"spec": MINIMAL_SPEC},
        headers=auth_headers,
    )
    assert r.status_code == 400




# ── /run fn_ref validation (Fix #25) ─────────────────────────────────────────

@pytest.mark.asyncio
async def test_run_fn_ref_injection_rejected(client, auth_headers):
    """Fix #25: /run must reject malicious fn_refs just like /compile does.
    Previously /run skipped validate_spec(), so path-traversal fn_refs reached exec().
    """
    spec = copy.deepcopy(MINIMAL_SPEC)
    spec["nodes"].append({
        "id": "transform-1",
        "type": "transform",
        "position": {"x": 150, "y": 0},
        "mode": "fn_ref",
        "fn_ref": "../../../etc/passwd",   # path traversal — must be blocked before exec()
    })
    spec["edges"].append({
        "id": "e2", "type": "direct", "from": "input-1", "to": "transform-1",
    })
    r = await client.post("/run", json={"spec": spec}, headers=auth_headers)
    assert r.status_code == 400, (
        f"Expected 400 from /run with malicious fn_ref, got {r.status_code}: {r.text}"
    )
    assert "fn_ref" in r.json()["detail"]


@pytest.mark.asyncio
async def test_run_shell_injection_fn_ref_rejected(client, auth_headers):
    """Fix #25: shell-injection fn_ref must be caught at /run, not just /compile."""
    spec = copy.deepcopy(MINIMAL_SPEC)
    spec["nodes"].append({
        "id": "transform-2",
        "type": "transform",
        "position": {"x": 150, "y": 0},
        "mode": "fn_ref",
        "fn_ref": "os.path:join; import os",   # semicolon injection
    })
    spec["edges"].append({
        "id": "e3", "type": "direct", "from": "input-1", "to": "transform-2",
    })
    r = await client.post("/run", json={"spec": spec}, headers=auth_headers)
    assert r.status_code == 400
    assert "fn_ref" in r.json()["detail"]
# ── _build_initial_state unit tests (Fix #22) ─────────────────────────────────

def test_build_initial_state_empty():
    assert _build_initial_state({}) == {}


def test_build_initial_state_string():
    spec = {
        "state_schema": {
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
        }
    }
    state = _build_initial_state(spec)
    assert state == {"query": ""}


def test_build_initial_state_with_default():
    spec = {
        "state_schema": {
            "type": "object",
            "properties": {"retries": {"type": "integer", "default": 3}},
            "required": ["retries"],
        }
    }
    assert _build_initial_state(spec) == {"retries": 3}


def test_build_initial_state_union_type():
    """Fix #22: union type arrays pick first non-null type."""
    spec = {
        "state_schema": {
            "type": "object",
            "properties": {"value": {"type": ["string", "null"]}},
            "required": ["value"],
        }
    }
    assert _build_initial_state(spec) == {"value": ""}


def test_build_initial_state_null_type():
    spec = {
        "state_schema": {
            "type": "object",
            "properties": {"nothing": {"type": "null"}},
            "required": ["nothing"],
        }
    }
    assert _build_initial_state(spec) == {"nothing": None}


def test_build_initial_state_unknown_type():
    """Unknown types should default to None, not crash."""
    spec = {
        "state_schema": {
            "type": "object",
            "properties": {"x": {"type": "custom_type"}},
            "required": ["x"],
        }
    }
    assert _build_initial_state(spec) == {"x": None}


# ── Security headers (Fix #9) ─────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_security_headers_present(client):
    r = await client.get("/health")
    assert r.headers.get("X-Content-Type-Options") == "nosniff"
    assert r.headers.get("X-Frame-Options") == "DENY"
    assert "Content-Security-Policy" in r.headers
