"""
Tests for GET /prompts, GET /prompts/{name}, and resolve_prompts().

GET /prompts and GET /prompts/{name} return stubs in TESTING=true mode.
resolve_prompts() is tested directly with a mocked Langfuse client using
unittest.mock.patch to exercise cache hit, cache miss, mixed flows, and
graceful fallback when Langfuse is unreachable.

All HTTP endpoint tests use the in-memory SQLite database (no Postgres needed).
"""
import copy
import os
import time
from unittest.mock import MagicMock, patch

import pytest

# ── helpers ───────────────────────────────────────────────────────────────────

async def _register(client, email: str, password: str = "Password1") -> dict:
    r = await client.post("/auth/register", json={"email": email, "password": password})
    assert r.status_code == 201, r.text
    return r.json()


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _llm_call_node(node_id: str = "llm-1", prompt_template: str = "Hello {{$.state.input}}",
                   prompt_ref: dict | None = None) -> dict:
    node: dict = {
        "id": node_id, "type": "llm_call",
        "position": {"x": 100, "y": 100},
        "label": "Test LLM", "output_key": "answer",
    }
    if prompt_template:
        node["prompt_template"] = prompt_template
    if prompt_ref:
        node["prompt_ref"] = prompt_ref
    return node


def _minimal_spec_with_llm(prompt_ref: dict | None = None,
                            prompt_template: str = "Hello") -> dict:
    return {
        "spec_version": "0.2.0",
        "id": "test-flow",
        "name": "Test Flow",
        "nodes": [
            {"id": "input-1",  "type": "input",  "position": {"x": 0,   "y": 0}},
            _llm_call_node("llm-1", prompt_template=prompt_template, prompt_ref=prompt_ref),
            {"id": "output-1", "type": "output", "position": {"x": 600, "y": 0}},
        ],
        "edges": [
            {"id": "e1", "type": "direct", "from": "input-1",  "to": "llm-1"},
            {"id": "e2", "type": "direct", "from": "llm-1",    "to": "output-1"},
        ],
    }


# ── GET /prompts ───────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_list_prompts_returns_empty_in_testing(client, auth_headers):
    """TESTING=true → empty list (no Langfuse configured in CI)."""
    r = await client.get("/prompts", headers=auth_headers)
    assert r.status_code == 200, r.text
    assert r.json() == []


@pytest.mark.asyncio
async def test_list_prompts_requires_auth(client):
    r = await client.get("/prompts")
    assert r.status_code == 401, r.text


@pytest.mark.asyncio
async def test_list_prompts_limit_param_accepted(client, auth_headers):
    """limit query param is accepted without error."""
    r = await client.get("/prompts?limit=10", headers=auth_headers)
    assert r.status_code == 200, r.text


# ── GET /prompts/{name} ───────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_get_prompt_returns_404_in_testing(client, auth_headers):
    """TESTING=true → 404 for any prompt name (Langfuse not configured)."""
    r = await client.get("/prompts/rag-system-prompt", headers=auth_headers)
    assert r.status_code == 404, r.text


@pytest.mark.asyncio
async def test_get_prompt_requires_auth(client):
    r = await client.get("/prompts/any-prompt")
    assert r.status_code == 401, r.text


# ── resolve_prompts() — unit tests ────────────────────────────────────────────

@pytest.mark.asyncio
async def test_resolve_prompts_noop_in_testing():
    """TESTING=true (default in test suite) → spec returned unchanged."""
    from prompt_resolver import resolve_prompts

    spec = _minimal_spec_with_llm(prompt_ref={"name": "rag-prompt"})
    result = await resolve_prompts(spec)
    # Should be the same object (no copy needed when no resolution happens)
    assert result is spec


@pytest.mark.asyncio
async def test_resolve_prompts_noop_when_no_prompt_ref():
    """Spec with no prompt_ref nodes returns the same spec unchanged."""
    from prompt_resolver import resolve_prompts

    spec = _minimal_spec_with_llm(prompt_template="Hello world")
    result = await resolve_prompts(spec)
    assert result is spec


@pytest.mark.asyncio
async def test_resolve_prompts_injects_prompt_template():
    """When Langfuse is enabled and a node has prompt_ref, inject resolved text."""
    import prompt_resolver as pr
    from prompt_resolver import _cache_clear, resolve_prompts

    _cache_clear()
    mock_prompt = MagicMock()
    mock_prompt.prompt = "You are a RAG assistant. Query: {{$.state.question}}"
    mock_client = MagicMock()
    mock_client.get_prompt.return_value = mock_prompt

    spec = _minimal_spec_with_llm(
        prompt_ref={"name": "rag-prompt", "version": 3},
        prompt_template="",  # empty inline — will be replaced by resolver
    )

    with patch.object(pr, "_LANGFUSE_ENABLED", True), \
         patch.object(pr, "_lf_get_client", return_value=mock_client), \
         patch.dict(os.environ, {"TESTING": "false"}):
        result = await resolve_prompts(spec)

    llm_node = next(n for n in result["nodes"] if n.get("type") == "llm_call")
    assert llm_node["prompt_template"] == "You are a RAG assistant. Query: {{$.state.question}}"
    mock_client.get_prompt.assert_called_once_with(
        "rag-prompt", version=3, label="production"
    )


@pytest.mark.asyncio
async def test_resolve_prompts_cache_hit_no_second_api_call():
    """Second call within TTL uses cache — Langfuse SDK called only once."""
    import prompt_resolver as pr
    from prompt_resolver import _cache_clear, resolve_prompts

    _cache_clear()
    mock_prompt = MagicMock()
    mock_prompt.prompt = "Cached prompt text"
    mock_client = MagicMock()
    mock_client.get_prompt.return_value = mock_prompt

    spec = _minimal_spec_with_llm(
        prompt_ref={"name": "cached-prompt"},
        prompt_template="",
    )

    with patch.object(pr, "_LANGFUSE_ENABLED", True), \
         patch.object(pr, "_lf_get_client", return_value=mock_client), \
         patch.dict(os.environ, {"TESTING": "false"}):
        await resolve_prompts(spec)
        await resolve_prompts(copy.deepcopy(spec))  # second call

    # SDK's get_prompt() should have been called exactly once
    assert mock_client.get_prompt.call_count == 1


@pytest.mark.asyncio
async def test_resolve_prompts_cache_miss_after_expiry():
    """After TTL expires, the next call fetches from Langfuse again."""
    import prompt_resolver as pr
    from prompt_resolver import _cache_clear, _cache_set, resolve_prompts

    _cache_clear()
    # Manually insert a stale entry (ts = now - TTL - 1)
    stale_ts = time.monotonic() - pr._CACHE_TTL - 1
    pr._cache["stale-prompt::production"] = {"text": "old text", "ts": stale_ts}

    mock_prompt = MagicMock()
    mock_prompt.prompt = "Fresh prompt text"
    mock_client = MagicMock()
    mock_client.get_prompt.return_value = mock_prompt

    spec = _minimal_spec_with_llm(
        prompt_ref={"name": "stale-prompt"},
        prompt_template="",
    )

    with patch.object(pr, "_LANGFUSE_ENABLED", True), \
         patch.object(pr, "_lf_get_client", return_value=mock_client), \
         patch.dict(os.environ, {"TESTING": "false"}):
        result = await resolve_prompts(spec)

    llm_node = next(n for n in result["nodes"] if n.get("type") == "llm_call")
    assert llm_node["prompt_template"] == "Fresh prompt text"
    assert mock_client.get_prompt.call_count == 1


@pytest.mark.asyncio
async def test_resolve_prompts_mixed_flow_only_resolves_nodes_with_ref():
    """Nodes without prompt_ref are left untouched; only prompt_ref nodes are resolved."""
    import prompt_resolver as pr
    from prompt_resolver import _cache_clear, resolve_prompts

    _cache_clear()
    mock_prompt = MagicMock()
    mock_prompt.prompt = "Resolved!"
    mock_client = MagicMock()
    mock_client.get_prompt.return_value = mock_prompt

    spec = {
        "spec_version": "0.2.0",
        "id": "mixed-flow",
        "name": "Mixed",
        "nodes": [
            {"id": "input-1",  "type": "input",  "position": {"x": 0,   "y": 0}},
            {
                "id": "llm-with-ref", "type": "llm_call", "output_key": "a",
                "position": {"x": 100, "y": 0},
                "prompt_template": "",
                "prompt_ref": {"name": "managed-prompt"},
            },
            {
                "id": "llm-inline", "type": "llm_call", "output_key": "b",
                "position": {"x": 300, "y": 0},
                "prompt_template": "Inline prompt stays as-is",
            },
            {"id": "output-1", "type": "output", "position": {"x": 500, "y": 0}},
        ],
        "edges": [
            {"id": "e1", "type": "direct", "from": "input-1",     "to": "llm-with-ref"},
            {"id": "e2", "type": "direct", "from": "llm-with-ref","to": "llm-inline"},
            {"id": "e3", "type": "direct", "from": "llm-inline",  "to": "output-1"},
        ],
    }

    with patch.object(pr, "_LANGFUSE_ENABLED", True), \
         patch.object(pr, "_lf_get_client", return_value=mock_client), \
         patch.dict(os.environ, {"TESTING": "false"}):
        result = await resolve_prompts(spec)

    nodes_by_id = {n["id"]: n for n in result["nodes"]}
    assert nodes_by_id["llm-with-ref"]["prompt_template"] == "Resolved!"
    assert nodes_by_id["llm-inline"]["prompt_template"] == "Inline prompt stays as-is"


@pytest.mark.asyncio
async def test_resolve_prompts_graceful_fallback_when_langfuse_unreachable():
    """When Langfuse raises an exception, prompt_template is left unchanged."""
    import prompt_resolver as pr
    from prompt_resolver import _cache_clear, resolve_prompts

    _cache_clear()
    mock_client = MagicMock()
    mock_client.get_prompt.side_effect = ConnectionError("Langfuse is down")

    spec = _minimal_spec_with_llm(
        prompt_ref={"name": "unreachable-prompt"},
        prompt_template="fallback inline text",
    )

    with patch.object(pr, "_LANGFUSE_ENABLED", True), \
         patch.object(pr, "_lf_get_client", return_value=mock_client), \
         patch.dict(os.environ, {"TESTING": "false"}):
        result = await resolve_prompts(spec)  # must not raise

    llm_node = next(n for n in result["nodes"] if n.get("type") == "llm_call")
    # Fallback: original prompt_template preserved
    assert llm_node["prompt_template"] == "fallback inline text"


# ── Compile roundtrip with prompt_ref ─────────────────────────────────────────

@pytest.mark.asyncio
async def test_compile_with_prompt_ref_noop_in_testing(client, auth_headers):
    """In TESTING=true, resolve_prompts is a no-op.  A spec with both prompt_ref
    AND a fallback prompt_template should compile successfully."""
    spec = _minimal_spec_with_llm(
        prompt_ref={"name": "rag-prompt"},
        prompt_template="Fallback inline prompt",  # needed since resolver is a no-op in CI
    )
    r = await client.post("/compile?runtime=langgraph",
                          json={"spec": spec}, headers=auth_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["runtime"] == "langgraph"
    assert "ChatOpenAI" in body["code"]
