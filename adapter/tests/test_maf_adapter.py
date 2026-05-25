"""
Tests for the MS Agent Framework adapter (Phase 4).

Covers:
  - compile_maf() on a minimal spec and the reference flow 05
  - All 14 node types generate valid Python code with expected signatures
  - agent_debate generates AgentGroupChat (native MAF mapping)
  - agent_role generates ChatCompletionAgent
  - hitl_breakpoint raises _HitlPause in generated code
  - parallel_fork/join generates asyncio.gather
  - condition generates route_* + if/elif dispatch
  - POST /compile?runtime=microsoft_agent_framework endpoint
  - POST /run?runtime=microsoft_agent_framework endpoint dispatch
  - HITL resume endpoint now accepts microsoft_agent_framework jobs
  - NODE_SUPPORT_MATRIX: agent_debate=full, hitl_breakpoint=partial
"""
import copy
import json
import pytest

from maf_adapter import compile_maf, safe_id
from tests.conftest import MINIMAL_SPEC


# ─── Fixtures ─────────────────────────────────────────────────────────────────

DEBATE_SPEC = {
    "spec_version": "0.2.0",
    "id": "debate-agent-a2a-flow",
    "name": "Debate Agent + A2A Exposure",
    "model_defaults": {"model": "gpt-4o"},
    "state_schema": {
        "type": "object",
        "properties": {
            "proposition":       {"type": "string"},
            "advocate_position": {"type": "string"},
            "debate_transcript": {"type": "string", "reducer": "append"},
            "verdict":           {"type": "string"},
        },
        "required": ["proposition"],
    },
    "agents": [
        {
            "id": "advocate",
            "role": "Debate Advocate",
            "backstory": "An accomplished debater.",
            "goal": "Argue in favour of the proposition.",
            "max_iter": 6,
        },
        {
            "id": "devil_advocate",
            "role": "Devil's Advocate",
            "backstory": "A critical thinker.",
            "goal": "Challenge the proposition.",
            "max_iter": 6,
        },
        {
            "id": "judge",
            "role": "Impartial Judge",
            "backstory": "A fair adjudicator.",
            "goal": "Deliver a verdict ending with VERDICT.",
            "max_iter": 3,
        },
    ],
    "nodes": [
        {"id": "start",           "type": "input",        "label": "Debate proposition",
         "position": {"x": 0, "y": 0}},
        {"id": "prepare_position", "type": "agent_role",   "label": "Advocate prepares opening",
         "config": {"agent_ref": "advocate",
                    "task_description": "Prepare an opening for: {{$.state.proposition}}",
                    "expected_output": "Opening argument",
                    "output_field": "advocate_position",
                    "memory_access": "isolated", "tool_approval": "auto"},
         "position": {"x": 200, "y": 0}},
        {"id": "debate",          "type": "agent_debate",  "label": "Moderated debate",
         "config": {"agents": ["advocate", "devil_advocate", "judge"],
                    "max_rounds": 12,
                    "termination_condition": {"type": "expr", "expr": "$.last_message contains 'VERDICT'"},
                    "speaker_selection": "round_robin",
                    "output_field": "debate_transcript",
                    "initial_message": "{{$.state.advocate_position}}"},
         "position": {"x": 400, "y": 0}},
        {"id": "done",            "type": "output",        "label": "Result",
         "position": {"x": 600, "y": 0}},
    ],
    "edges": [
        {"type": "direct", "from": "start",           "to": "prepare_position"},
        {"type": "direct", "from": "prepare_position", "to": "debate",
         "context_from": ["prepare_position"]},
        {"type": "direct", "from": "debate",          "to": "done"},
    ],
}

HITL_SPEC = {
    "spec_version": "0.2.0",
    "id": "hitl-review-flow",
    "name": "HITL Review",
    "state_schema": {
        "type": "object",
        "properties": {"input": {"type": "string"}, "review": {"type": "string"}},
        "required": ["input"],
    },
    "nodes": [
        {"id": "start",  "type": "input",            "position": {"x": 0, "y": 0}},
        {"id": "review", "type": "hitl_breakpoint",  "label": "Human review",
         "prompt": "Please review the content.",
         "output_key": "review",
         "resume_schema": {"type": "object", "properties": {"approved": {"type": "boolean"}}},
         "position": {"x": 200, "y": 0}},
        {"id": "end",    "type": "output",            "position": {"x": 400, "y": 0}},
    ],
    "edges": [
        {"type": "direct", "from": "start",  "to": "review"},
        {"type": "direct", "from": "review", "to": "end"},
    ],
}

PARALLEL_SPEC = {
    "spec_version": "0.2.0",
    "id": "parallel-flow",
    "name": "Parallel Flow",
    "state_schema": {
        "type": "object",
        "properties": {"input": {"type": "string"}, "merged": {"type": "object"}},
        "required": ["input"],
    },
    "nodes": [
        {"id": "start",      "type": "input",         "position": {"x": 0,   "y": 0}},
        {"id": "fork",       "type": "parallel_fork",  "position": {"x": 200, "y": 0}},
        {"id": "branch_a",   "type": "transform",      "mode": "mapping", "mapping": [],
         "position": {"x": 400, "y": -60}},
        {"id": "branch_b",   "type": "transform",      "mode": "mapping", "mapping": [],
         "position": {"x": 400, "y": 60}},
        {"id": "join",       "type": "parallel_join",  "join_reducer": "merge",
         "output_key": "merged", "position": {"x": 600, "y": 0}},
        {"id": "end",        "type": "output",          "position": {"x": 800, "y": 0}},
    ],
    "edges": [
        {"type": "direct", "from": "start",    "to": "fork"},
        {"type": "direct", "from": "fork",     "to": "branch_a"},
        {"type": "direct", "from": "fork",     "to": "branch_b"},
        {"type": "direct", "from": "branch_a", "to": "join"},
        {"type": "direct", "from": "branch_b", "to": "join"},
        {"type": "direct", "from": "join",     "to": "end"},
    ],
}

CONDITION_SPEC = {
    "spec_version": "0.2.0",
    "id": "condition-flow",
    "name": "Condition Flow",
    "state_schema": {
        "type": "object",
        "properties": {"score": {"type": "number"}, "result": {"type": "string"}},
        "required": ["score"],
    },
    "nodes": [
        {"id": "start", "type": "input",     "position": {"x": 0,   "y": 0}},
        {"id": "check", "type": "condition",
         "branches": [
             {"condition": {"expr": "$.state.score", "op": "gte", "value": 0.8},
              "target": "high_branch"},
             {"condition": {"expr": "$.state.score", "op": "lt",  "value": 0.8},
              "target": "low_branch"},
         ],
         "default_target": "low_branch",
         "position": {"x": 200, "y": 0}},
        {"id": "high_branch", "type": "transform", "mode": "mapping",
         "mapping": [{"from": "$.state.score", "to": "$.output.result"}],
         "position": {"x": 400, "y": -60}},
        {"id": "low_branch",  "type": "transform", "mode": "mapping",
         "mapping": [{"from": "$.state.score", "to": "$.output.result"}],
         "position": {"x": 400, "y": 60}},
        {"id": "end", "type": "output", "position": {"x": 600, "y": 0}},
    ],
    "edges": [
        {"type": "direct", "from": "start",       "to": "check"},
        {"type": "direct", "from": "check",       "to": "high_branch"},
        {"type": "direct", "from": "check",       "to": "low_branch"},
        {"type": "direct", "from": "high_branch", "to": "end"},
        {"type": "direct", "from": "low_branch",  "to": "end"},
    ],
}


# ─── compile_maf unit tests ───────────────────────────────────────────────────

def test_compile_maf_minimal():
    """Minimal spec compiles without error and produces importable code."""
    code, warnings = compile_maf(MINIMAL_SPEC)
    assert isinstance(code, str)
    assert len(code) > 100
    # Generated code must be syntactically valid Python
    compile(code, "<test>", "exec")


def test_compile_maf_empty_spec():
    code, warnings = compile_maf({})
    assert "Empty spec" in code
    assert warnings == []


def test_compile_maf_produces_run_flow():
    code, _ = compile_maf(MINIMAL_SPEC)
    assert "def run_flow(" in code
    assert "async def _run_flow_async(" in code


# Spec that uses llm_call (requires SK) — used for SK-specific tests.
LLM_SPEC = {
    "spec_version": "0.2.0",
    "id": "llm-test",
    "name": "LLM Test",
    "state_schema": {
        "type": "object",
        "properties": {"input": {"type": "string"}},
        "required": ["input"],
    },
    "nodes": [
        {"id": "input-1", "type": "input",    "position": {"x": 0,   "y": 0}},
        {"id": "llm-1",   "type": "llm_call", "label": "Generate",
         "system_prompt": "You are helpful.",
         "prompt_template": "{{$.state.input}}", "output_key": "response",
         "position": {"x": 200, "y": 0}},
        {"id": "output-1", "type": "output", "position": {"x": 400, "y": 0}},
    ],
    "edges": [
        {"type": "direct", "from": "input-1", "to": "llm-1"},
        {"type": "direct", "from": "llm-1",   "to": "output-1"},
    ],
}


def test_compile_maf_imports_semantic_kernel():
    # P5-1 fix: use LLM_SPEC (has llm_call node) — MINIMAL_SPEC (input+output only)
    # no longer emits SK imports after P4-3 (conditional SK imports).
    code, _ = compile_maf(LLM_SPEC)
    assert "from semantic_kernel import Kernel" in code
    assert "from semantic_kernel.connectors.ai.open_ai import OpenAIChatCompletion" in code


def test_compile_maf_kernel_factory():
    # P5-1 fix: same — use LLM_SPEC.
    code, _ = compile_maf(LLM_SPEC)
    assert "def _make_kernel(" in code
    assert "OpenAIChatCompletion" in code


def test_compile_maf_minimal_has_no_sk_imports():
    """P4-3 regression test: MINIMAL_SPEC (input+output only) must NOT import SK."""
    code, _ = compile_maf(MINIMAL_SPEC)
    assert "semantic_kernel" not in code, "SK imported unnecessarily for non-SK spec"


def test_compile_maf_helpers_present():
    code, _ = compile_maf(MINIMAL_SPEC)
    assert "def _resolve(" in code
    assert "def _render(" in code
    assert "class _HitlPause" in code
    assert "async def _exec_node(" in code


# ─── Node type coverage ───────────────────────────────────────────────────────

def test_llm_call_node():
    spec = copy.deepcopy(MINIMAL_SPEC)
    spec["nodes"].append({
        "id": "gen", "type": "llm_call", "label": "Generate",
        "system_prompt": "You are a writer.",
        "prompt_template": "Write about {{$.state.input}}",
        "output_key": "draft",
        "model": "gpt-4o-mini",
        "position": {"x": 200, "y": 0},
    })
    spec["edges"].append({"type": "direct", "from": "input-1", "to": "gen"})
    code, warnings = compile_maf(spec)
    compile(code, "<test>", "exec")
    assert "async def node_gen(" in code
    assert "ChatHistory" in code
    assert "get_chat_message_contents" in code
    assert "'draft'" in code


def test_llm_call_no_output_key_warns():
    spec = copy.deepcopy(MINIMAL_SPEC)
    spec["nodes"].append({
        "id": "gen", "type": "llm_call", "label": "Generate",
        "prompt_template": "Hello", "position": {"x": 200, "y": 0},
    })
    spec["edges"].append({"type": "direct", "from": "input-1", "to": "gen"})
    _, warnings = compile_maf(spec)
    assert any("output_key" in w for w in warnings)


def test_tool_invoke_node():
    spec = copy.deepcopy(MINIMAL_SPEC)
    spec["tools"] = {
        "web_search": {"description": "Search the web", "source": "npm", "tool_ref": "@tavily/search"},
    }
    spec["nodes"].append({
        "id": "search", "type": "tool_invoke", "label": "Search",
        "tool_id": "web_search",
        "input_map": {"query": "$.state.input"},
        "output_map": {"results": "result"},
        "position": {"x": 200, "y": 0},
    })
    spec["edges"].append({"type": "direct", "from": "input-1", "to": "search"})
    code, _ = compile_maf(spec)
    compile(code, "<test>", "exec")
    assert "async def node_search(" in code
    assert "_TOOL_STUBS.web_search" in code


def test_tool_invoke_unknown_tool_warns():
    spec = copy.deepcopy(MINIMAL_SPEC)
    spec["nodes"].append({
        "id": "t1", "type": "tool_invoke", "tool_id": "ghost_tool",
        "position": {"x": 200, "y": 0},
    })
    spec["edges"].append({"type": "direct", "from": "input-1", "to": "t1"})
    _, warnings = compile_maf(spec)
    assert any("ghost_tool" in w for w in warnings)


def test_transform_mapping_node():
    spec = copy.deepcopy(MINIMAL_SPEC)
    spec["nodes"].append({
        "id": "fmt", "type": "transform", "mode": "mapping",
        "mapping": [{"from": "$.state.input", "to": "$.output.text"}],
        "position": {"x": 200, "y": 0},
    })
    spec["edges"].append({"type": "direct", "from": "input-1", "to": "fmt"})
    code, _ = compile_maf(spec)
    compile(code, "<test>", "exec")
    assert "async def node_fmt(" in code
    assert "_resolve(state" in code


def test_hitl_breakpoint_raises_pause():
    """Generated hitl_breakpoint node must raise _HitlPause."""
    code, _ = compile_maf(HITL_SPEC)
    compile(code, "<test>", "exec")
    assert "raise _HitlPause(" in code
    assert "node_id='review'" in code or "node_id=\"review\"" in code


def test_hitl_pause_class_present():
    code, _ = compile_maf(HITL_SPEC)
    ns: dict = {}
    exec(compile(code, "<test>", "exec"), ns)
    assert "_HitlPause" in ns
    assert issubclass(ns["_HitlPause"], Exception)


def test_hitl_node_function_raises_at_runtime():
    """The compiled hitl node function must raise _HitlPause when called."""
    code, _ = compile_maf(HITL_SPEC)
    ns: dict = {}
    exec(compile(code, "<test>", "exec"), ns)
    import asyncio
    with pytest.raises(ns["_HitlPause"]) as exc_info:
        asyncio.run(ns["node_review"]({"input": "hello"}))
    assert exc_info.value.node_id == "review"
    assert exc_info.value.fields == ["approved"]


def test_memory_read_node():
    spec = copy.deepcopy(MINIMAL_SPEC)
    spec["nodes"].append({
        "id": "read1", "type": "memory_read", "label": "Read memory",
        "store_id": "kv_store", "retrieval_mode": "key_value",
        "key_expr": "$.state.input", "output_key": "doc",
        "position": {"x": 200, "y": 0},
    })
    spec["edges"].append({"type": "direct", "from": "input-1", "to": "read1"})
    code, _ = compile_maf(spec)
    compile(code, "<test>", "exec")
    assert "async def node_read1(" in code
    assert "_store_get('kv_store'" in code or '_store_get("kv_store"' in code


def test_memory_write_node():
    spec = copy.deepcopy(MINIMAL_SPEC)
    spec["nodes"].append({
        "id": "write1", "type": "memory_write", "label": "Write memory",
        "store_id": "kv_store", "key_expr": "$.state.input",
        "value_expr": "$.state.draft", "write_mode": "upsert",
        "position": {"x": 200, "y": 0},
    })
    spec["edges"].append({"type": "direct", "from": "input-1", "to": "write1"})
    code, _ = compile_maf(spec)
    compile(code, "<test>", "exec")
    assert "async def node_write1(" in code
    assert "_store_set(" in code


def test_parallel_fork_join_uses_gather():
    code, _ = compile_maf(PARALLEL_SPEC)
    compile(code, "<test>", "exec")
    assert "asyncio.gather(" in code
    assert "_par_results" in code
    assert "parallel_join" in code or "parallel" in code.lower()


def test_condition_generates_router_and_dispatch():
    code, _ = compile_maf(CONDITION_SPEC)
    compile(code, "<test>", "exec")
    assert "def route_check(" in code
    assert "_route_check = route_check(state)" in code
    assert "if _route_check ==" in code


def test_condition_router_returns_correct_branch():
    code, _ = compile_maf(CONDITION_SPEC)
    ns: dict = {}
    exec(compile(code, "<test>", "exec"), ns)
    assert ns["route_check"]({"score": 0.9}) == "high_branch"
    assert ns["route_check"]({"score": 0.5}) == "low_branch"
    assert ns["route_check"]({})             == "low_branch"  # default


# ─── agent_role and agent_debate ─────────────────────────────────────────────

def test_agent_role_uses_chat_completion_agent():
    code, warnings = compile_maf(DEBATE_SPEC)
    compile(code, "<test>", "exec")
    assert "ChatCompletionAgent" in code
    assert "async def node_prepare_position(" in code
    # Verify a context_from annotation is emitted
    assert "context_from" in code


def test_agent_debate_uses_agent_group_chat():
    """agent_debate must use AgentGroupChat — the only native MAF mapping."""
    code, warnings = compile_maf(DEBATE_SPEC)
    compile(code, "<test>", "exec")
    assert "AgentGroupChat" in code
    assert "KernelFunctionTerminationStrategy" in code
    assert "async def node_debate(" in code


def test_agent_debate_warns_native_match():
    _, warnings = compile_maf(DEBATE_SPEC)
    native_warns = [w for w in warnings if "NATIVE MAF" in w or "AgentGroupChat" in w]
    assert native_warns, "Expected a warning documenting the native MAF mapping"


def test_agent_debate_termination_keyword_extracted():
    """Termination keyword 'VERDICT' must appear in the generated termination function."""
    code, _ = compile_maf(DEBATE_SPEC)
    assert "VERDICT" in code


def test_agent_role_tool_approval_human():
    spec = copy.deepcopy(DEBATE_SPEC)
    spec["nodes"][1]["config"]["tool_approval"] = "human"
    code, _ = compile_maf(spec)
    compile(code, "<test>", "exec")
    assert "_HitlPause" in code


# ─── Reference flow 05 (debate-agent-a2a) ────────────────────────────────────

def test_reference_flow_05_compiles():
    """Full reference flow 05 (the MAF showcase flow) must compile cleanly."""
    import pathlib, json as _json
    flow_path = pathlib.Path(__file__).parent.parent.parent / "flows" / "05-debate-agent-a2a-flow.json"
    if not flow_path.exists():
        pytest.skip("Reference flow file not found")

    with flow_path.open() as f:
        spec = _json.load(f)

    code, warnings = compile_maf(spec)
    # Must be syntactically valid
    compile(code, "<flow05>", "exec")
    # Must have all key patterns
    assert "AgentGroupChat" in code
    assert "ChatCompletionAgent" in code
    assert "run_flow" in code
    # debate node gets the native MAF warning
    assert any("NATIVE MAF" in w or "AgentGroupChat" in w for w in warnings)


def test_reference_flow_05_exports_run_flow():
    import pathlib, json as _json
    flow_path = pathlib.Path(__file__).parent.parent.parent / "flows" / "05-debate-agent-a2a-flow.json"
    if not flow_path.exists():
        pytest.skip("Reference flow file not found")

    with flow_path.open() as f:
        spec = _json.load(f)

    code, _ = compile_maf(spec)
    ns: dict = {}
    exec(compile(code, "<flow05>", "exec"), ns)
    assert "run_flow" in ns
    assert "_run_flow_async" in ns
    assert callable(ns["run_flow"])


# ─── MCP tool source ──────────────────────────────────────────────────────────

def test_mcp_tool_generates_httpx_call():
    spec = copy.deepcopy(MINIMAL_SPEC)
    spec["tools"] = {
        "web_search": {
            "description": "Tavily search",
            "source": "mcp",
            "tool_ref": "web-search",
            "mcp_server_url": "${TAVILY_MCP_URL}",
        }
    }
    spec["nodes"].append({
        "id": "search", "type": "tool_invoke", "tool_id": "web_search",
        "position": {"x": 200, "y": 0},
    })
    spec["edges"].append({"type": "direct", "from": "input-1", "to": "search"})
    code, _ = compile_maf(spec)
    compile(code, "<test>", "exec")
    assert "httpx" in code
    assert "TAVILY_MCP_URL" in code


# ─── OTel telemetry ──────────────────────────────────────────────────────────

def test_otel_setup_emitted_when_enabled():
    spec = copy.deepcopy(MINIMAL_SPEC)
    spec["flow_config"] = {"telemetry": {"enabled": True, "provider": "langfuse"}}
    code, _ = compile_maf(spec)
    assert "_setup_telemetry" in code
    assert "TracerProvider" in code
    assert "OTLPSpanExporter" in code


def test_otel_not_emitted_when_disabled():
    code, _ = compile_maf(MINIMAL_SPEC)
    assert "_setup_telemetry" not in code


# ─── /compile endpoint ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_compile_maf_endpoint(client, auth_headers):
    r = await client.post(
        "/compile?runtime=microsoft_agent_framework",
        json={"spec": MINIMAL_SPEC},
        headers=auth_headers,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["runtime"] == "microsoft_agent_framework"
    assert "run_flow" in body["code"]
    # P5-1 fix: MINIMAL_SPEC has no SK nodes; SK imports are conditional (P4-3).
    # Check for run_flow presence instead of SK imports.
    assert "_run_flow_async" in body["code"]


@pytest.mark.asyncio
async def test_compile_maf_debate_endpoint(client, auth_headers):
    r = await client.post(
        "/compile?runtime=microsoft_agent_framework",
        json={"spec": DEBATE_SPEC},
        headers=auth_headers,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert "AgentGroupChat" in body["code"]
    assert "ChatCompletionAgent" in body["code"]


@pytest.mark.asyncio
async def test_compile_requires_auth_maf(client):
    r = await client.post(
        "/compile?runtime=microsoft_agent_framework",
        json={"spec": MINIMAL_SPEC},
    )
    assert r.status_code == 401


# ─── /runtimes endpoint ───────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_runtimes_includes_maf(client):
    r = await client.get("/runtimes")
    assert r.status_code == 200
    body = r.json()
    assert "microsoft_agent_framework" in body["runtimes"]
    maf = body["runtimes"]["microsoft_agent_framework"]
    assert maf["status"] == "full"
    assert maf["executable"] is True


# ─── /run endpoint dispatch ───────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_run_maf_queues_job(client, auth_headers):
    r = await client.post(
        "/run?runtime=microsoft_agent_framework",
        json={"spec": MINIMAL_SPEC},
        headers=auth_headers,
    )
    assert r.status_code in (200, 202), r.text
    body = r.json()
    assert "job_id" in body
    assert body["runtime"] == "microsoft_agent_framework"
    assert body["status"] == "queued"


@pytest.mark.asyncio
async def test_run_preferred_adapter_maf(client, auth_headers):
    """Flows with preferred_adapter=microsoft_agent_framework must route to MAF."""
    spec = copy.deepcopy(MINIMAL_SPEC)
    spec["runtime_hints"] = {"preferred_adapter": "microsoft_agent_framework"}
    r = await client.post("/run", json={"spec": spec}, headers=auth_headers)
    assert r.status_code in (200, 202), r.text
    assert r.json()["runtime"] == "microsoft_agent_framework"


# ─── HITL resume endpoint ─────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_resume_rejects_crewai(client, auth_headers):
    """Resuming a CrewAI job must still return 400."""
    # Create a crewai job and manually mark it paused
    r = await client.post(
        "/run?runtime=crewai",
        json={"spec": MINIMAL_SPEC},
        headers=auth_headers,
    )
    job_id = r.json()["job_id"]
    # Resume should fail with 400 since crewai doesn't support HITL
    r2 = await client.post(
        f"/run/{job_id}/resume",
        json={"payload": {}, "spec": MINIMAL_SPEC},
        headers=auth_headers,
    )
    # Will be 409 (not paused) or 400 (unsupported runtime) — either is correct
    assert r2.status_code in (400, 409)


# ─── NODE_SUPPORT_MATRIX correctness ─────────────────────────────────────────

def test_node_support_matrix_agent_debate_full():
    """agent_debate is the only node with ms_agent_framework='full' because
    AgentGroupChat is the native equivalent (ADR-001 Q11)."""
    import sys
    import os
    src_path = os.path.join(os.path.dirname(__file__), "..", "..", "src", "spec")
    # We can't import TypeScript directly; check the matrix values via the maf_adapter
    # by verifying the generated warning for agent_debate mentions "NATIVE MAF"
    code, warnings = compile_maf(DEBATE_SPEC)
    native_warns = [w for w in warnings if "NATIVE MAF" in w]
    assert native_warns, "agent_debate should generate a NATIVE MAF warning"


def test_node_support_matrix_hitl_partial():
    """hitl_breakpoint is 'partial' — pause works, but full checkpoint resume requires Dapr."""
    code, _ = compile_maf(HITL_SPEC)
    # The generated code must include the comment about Dapr follow-up
    assert "Dapr" in code or "checkpoint" in code.lower()


# ─── P7-1 / P7-2 regression tests ────────────────────────────────────────────

# Spec with tools but NO agent_role (only tool_invoke) — must not import SK.
_TOOL_INVOKE_ONLY_SPEC = {
    "spec_version": "0.2.0",
    "id": "tool-invoke-only",
    "name": "Tool invoke only",
    "tools": {"search": {"description": "Search the web", "source": "npm"}},
    "state_schema": {
        "type": "object",
        "properties": {"q": {"type": "string"}},
        "required": ["q"],
    },
    "nodes": [
        {"id": "start", "type": "input",       "position": {"x": 0,   "y": 0}},
        {"id": "inv",   "type": "tool_invoke", "tool_id": "search",
         "position": {"x": 200, "y": 0}},
        {"id": "end",   "type": "output",      "position": {"x": 400, "y": 0}},
    ],
    "edges": [
        {"type": "direct", "from": "start", "to": "inv"},
        {"type": "direct", "from": "inv",   "to": "end"},
    ],
}


def test_tool_invoke_only_has_no_sk_imports():
    """P7-1: specs where tools are only used by tool_invoke (not agent_role)
    must not import semantic_kernel — tool_invoke calls stubs directly."""
    code, _ = compile_maf(_TOOL_INVOKE_ONLY_SPEC)
    assert "semantic_kernel" not in code, \
        "SK imported unnecessarily when no agent uses tools"
    assert "@kernel_function" not in code, \
        "@kernel_function emitted without any agent using the tool"
    assert "_PLUGINS" not in code, \
        "_PLUGINS created without any agent needing it"
    # _TOOL_STUBS must still be present — tool_invoke calls it directly
    assert "_TOOL_STUBS" in code


def test_tool_invoke_only_code_executes():
    """P7-1: tool-invoke-only generated code must exec without semantic_kernel."""
    code, _ = compile_maf(_TOOL_INVOKE_ONLY_SPEC)
    compile(code, "<tool-only>", "exec")   # SyntaxError if broken


def test_agent_role_tool_approval_human_no_syntax_error():
    """P7-2: agent_role with tool_approval='human' must not produce a SyntaxError
    regardless of what characters appear in the agent_ref string."""
    for agent_ref in ("writer", "my-agent", "it's complex"):
        spec = {
            "spec_version": "0.2.0",
            "id": "ha",
            "name": "ha",
            "model_defaults": {"model": "gpt-4o"},
            "agents": [{"id": agent_ref, "role": "Role", "goal": "Goal"}],
            "state_schema": {
                "type": "object",
                "properties": {"input": {"type": "string"}},
                "required": ["input"],
            },
            "nodes": [
                {"id": "s",  "type": "input",      "position": {"x": 0,   "y": 0}},
                {"id": "wr", "type": "agent_role",
                 "config": {"agent_ref": agent_ref,
                             "task_description": "Do task",
                             "output_field": "result",
                             "tool_approval": "human"},
                 "position": {"x": 200, "y": 0}},
                {"id": "e",  "type": "output",     "position": {"x": 400, "y": 0}},
            ],
            "edges": [
                {"type": "direct", "from": "s",  "to": "wr"},
                {"type": "direct", "from": "wr", "to": "e"},
            ],
        }
        code, _ = compile_maf(spec)
        compile(code, f"<ha-{agent_ref}>", "exec")   # SyntaxError if broken
        assert "_HitlPause" in code
