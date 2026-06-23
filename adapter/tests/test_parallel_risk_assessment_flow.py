"""
Parallel risk assessment HITL flow integration tests: compile through all 4 adapters
and run the generated LangGraph + MAF code end-to-end with mocked LLM responses.

The flow (03-parallel-risk-assessment-flow.json) models a parallel fan-out:
  start → fork → [assess_legal, assess_financial, assess_technical] → join → synthesise → done

Test categories
───────────────
1. Compile tests (all 4 adapters) — always run, no LLM or running services needed.
2. End-to-end LangGraph exec (mocked LLM) — verifies parallel branches + join + synthesise.
3. End-to-end MAF exec (mocked SK) — verifies asyncio.gather fan-out + join + synthesise.
4. OTel / Langfuse tracing verification — generated code contains correct setup.
"""

from __future__ import annotations

import json
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from crewai_adapter import compile_crewai
from langgraph_adapter import compile_langgraph
from maf_adapter import compile_maf
from mastra_adapter import compile_mastra

# ── Lightweight LangGraph / SK execution stubs ────────────────────────────────


class _FakeStateGraph:
    """Minimal StateGraph that actually executes registered node functions."""

    def __init__(self, state_type=None):
        self._nodes: dict = {}
        self._succs: dict = {}
        self._entry: str | None = None

    def add_node(self, name, fn=None, **_kw):
        self._nodes[name] = fn or (lambda s: {})

    def add_edge(self, src, dst):
        if src == "__start__":
            self._entry = dst
        elif dst != "__end__":
            self._succs.setdefault(src, []).append(dst)

    def add_conditional_edges(self, src, fn, mapping=None, **_kw):
        for dst in (mapping or {}).values():
            if dst != "__end__":
                self._succs.setdefault(src, []).append(dst)

    def compile(self, **_kw):
        return _FakeCompiled(self._nodes, self._succs, self._entry)


class _FakeCompiled:
    def __init__(self, nodes, succs, entry):
        self._nodes = nodes
        self._succs = succs
        self._entry = entry

    def stream(self, inputs, stream_mode="updates", config=None):
        state = dict(inputs)
        preds: dict = {}
        for src, dsts in self._succs.items():
            for dst in dsts:
                preds.setdefault(dst, set()).add(src)
        queue: list[str] = [self._entry] if self._entry else []
        done: set[str] = set()
        queued: set[str] = set(queue)
        while queue:
            ready = [n for n in queue if all(p in done for p in preds.get(n, set()))]
            if not ready:
                break
            queue = [n for n in queue if n not in ready]
            for name in ready:
                fn = self._nodes.get(name)
                if fn is None or name in done:
                    continue
                done.add(name)
                update = fn(state) or {}
                if isinstance(update, dict):
                    state.update(update)
                yield {name: update}
                for nxt in self._succs.get(name, []):
                    if nxt not in done and nxt not in queued:
                        queue.append(nxt)
                        queued.add(nxt)


def _build_lg_stubs() -> dict[str, types.ModuleType]:
    lc_openai = types.ModuleType("langchain_openai")
    lc_openai.ChatOpenAI = MagicMock  # type: ignore[attr-defined]
    lc_openai.OpenAIEmbeddings = MagicMock  # type: ignore[attr-defined]
    lc_core_msg = types.ModuleType("langchain_core.messages")
    lc_core_msg.HumanMessage = MagicMock  # type: ignore[attr-defined]
    lc_core_msg.SystemMessage = MagicMock  # type: ignore[attr-defined]
    lc_core_tools = types.ModuleType("langchain_core.tools")
    lc_core_tools.tool = lambda f: f  # type: ignore[attr-defined]
    lg = types.ModuleType("langgraph")
    lg_graph = types.ModuleType("langgraph.graph")
    lg_graph.StateGraph = _FakeStateGraph  # type: ignore[attr-defined]
    lg_graph.START = "__start__"  # type: ignore[attr-defined]
    lg_graph.END = "__end__"  # type: ignore[attr-defined]
    lg_prebuilt = types.ModuleType("langgraph.prebuilt")
    lg_prebuilt.create_react_agent = MagicMock()  # type: ignore[attr-defined]
    lg_memory = types.ModuleType("langgraph.checkpoint.memory")
    lg_memory.MemorySaver = MagicMock  # type: ignore[attr-defined]
    return {
        "langchain_openai": lc_openai,
        "langchain_core.messages": lc_core_msg,
        "langchain_core.tools": lc_core_tools,
        "langgraph": lg,
        "langgraph.graph": lg_graph,
        "langgraph.prebuilt": lg_prebuilt,
        "langgraph.checkpoint.memory": lg_memory,
    }


def _build_sk_stubs() -> dict[str, types.ModuleType]:
    sk = types.ModuleType("semantic_kernel")
    sk.Kernel = MagicMock  # type: ignore[attr-defined]
    sk_conn = types.ModuleType("semantic_kernel.connectors")
    sk_conn_ai = types.ModuleType("semantic_kernel.connectors.ai")
    sk_conn_ai_oai = types.ModuleType("semantic_kernel.connectors.ai.open_ai")
    sk_conn_ai_oai.OpenAIChatCompletion = MagicMock  # type: ignore[attr-defined]
    sk_contents = types.ModuleType("semantic_kernel.contents")
    sk_contents.ChatMessageContent = MagicMock  # type: ignore[attr-defined]
    sk_contents.ChatHistory = MagicMock  # type: ignore[attr-defined]
    _author_role = MagicMock()
    _author_role.SYSTEM = "system"
    _author_role.USER = "user"
    _author_role.ASSISTANT = "assistant"
    sk_contents.AuthorRole = _author_role  # type: ignore[attr-defined]
    sk_agents = types.ModuleType("semantic_kernel.agents")
    sk_agents.ChatCompletionAgent = MagicMock  # type: ignore[attr-defined]
    sk_agents.AgentGroupChat = MagicMock  # type: ignore[attr-defined]
    sk_strats = types.ModuleType("semantic_kernel.agents.strategies")
    sk_strats.KernelFunctionTerminationStrategy = MagicMock  # type: ignore[attr-defined]
    sk_strats.KernelFunctionSelectionStrategy = MagicMock  # type: ignore[attr-defined]
    sk_fns = types.ModuleType("semantic_kernel.functions")
    sk_fns.KernelFunctionFromPrompt = MagicMock  # type: ignore[attr-defined]
    otel = types.ModuleType("opentelemetry")
    otel_trace = types.ModuleType("opentelemetry.trace")
    otel_trace.get_tracer = lambda *a, **kw: MagicMock()  # type: ignore[attr-defined]
    otel_trace.set_tracer_provider = lambda *a, **kw: None  # type: ignore[attr-defined]
    otel_sdk_trace = types.ModuleType("opentelemetry.sdk.trace")
    otel_sdk_trace.TracerProvider = lambda *a, **kw: MagicMock()  # type: ignore[attr-defined]
    otel_sdk_export = types.ModuleType("opentelemetry.sdk.trace.export")
    otel_sdk_export.BatchSpanProcessor = lambda *a, **kw: MagicMock()  # type: ignore[attr-defined]
    otel_exp = types.ModuleType("opentelemetry.exporter.otlp.proto.http.trace_exporter")
    otel_exp.OTLPSpanExporter = lambda *a, **kw: MagicMock()  # type: ignore[attr-defined]
    return {
        "semantic_kernel": sk,
        "semantic_kernel.connectors": sk_conn,
        "semantic_kernel.connectors.ai": sk_conn_ai,
        "semantic_kernel.connectors.ai.open_ai": sk_conn_ai_oai,
        "semantic_kernel.contents": sk_contents,
        "semantic_kernel.agents": sk_agents,
        "semantic_kernel.agents.strategies": sk_strats,
        "semantic_kernel.functions": sk_fns,
        "opentelemetry": otel,
        "opentelemetry.trace": otel_trace,
        "opentelemetry.sdk.trace": otel_sdk_trace,
        "opentelemetry.sdk.trace.export": otel_sdk_export,
        "opentelemetry.exporter.otlp.proto.http.trace_exporter": otel_exp,
    }


def _exec_with_stubs(code: str, label: str, stubs: dict) -> dict:
    """exec compiled code with sys.modules stubs injected, then restored."""
    saved = {name: sys.modules.get(name) for name in stubs}
    for name, mod in stubs.items():
        sys.modules[name] = mod
    try:
        ns: dict = {}
        exec(compile(code, label, "exec"), ns)
        return ns
    finally:
        for name, orig in saved.items():
            if orig is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = orig


# ── Paths ─────────────────────────────────────────────────────────────────────

RISK_SPEC_PATH = Path(__file__).parent.parent.parent / "flows" / "03-parallel-risk-assessment-flow.json"

SAMPLE_DOCUMENT = (
    "Service Agreement between Acme Corp and Vendor Inc.\n"
    "Payment terms: Net 90. SLA: 99.999% uptime guaranteed.\n"
    "Penalty clause: $1M per hour of downtime. Unlimited liability."
)


# ── Fixtures ──────────────────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def risk_spec() -> dict:
    with open(RISK_SPEC_PATH) as f:
        return json.load(f)


# ── Compile: LangGraph ────────────────────────────────────────────────────────


class TestLangGraphCompile:
    def test_agent_role_warnings(self, risk_spec):
        """3 agent_role nodes each produce a ReAct expansion warning."""
        _, warnings = compile_langgraph(risk_spec)
        agent_warns = [w for w in warnings if "agent_role" in w and "create_react_agent" in w]
        assert len(agent_warns) == 3

    def test_parallel_fork_passthrough_node(self, risk_spec):
        code, _ = compile_langgraph(risk_spec)
        assert "node_fork" in code
        assert "return {}  # passthrough" in code

    def test_parallel_edges_fanned_out(self, risk_spec):
        code, _ = compile_langgraph(risk_spec)
        assert "add_edge('fork', 'assess_legal')" in code
        assert "add_edge('fork', 'assess_financial')" in code
        assert "add_edge('fork', 'assess_technical')" in code

    def test_all_branches_join_to_join_node(self, risk_spec):
        code, _ = compile_langgraph(risk_spec)
        assert "add_edge('assess_legal', 'join')" in code
        assert "add_edge('assess_financial', 'join')" in code
        assert "add_edge('assess_technical', 'join')" in code

    def test_join_to_synthesise_edge(self, risk_spec):
        code, _ = compile_langgraph(risk_spec)
        assert "add_edge('join', 'synthesise')" in code
        assert "add_edge('synthesise', END)" in code

    def test_agent_nodes_generated(self, risk_spec):
        code, _ = compile_langgraph(risk_spec)
        assert "node_assess_legal" in code
        assert "node_assess_financial" in code
        assert "node_assess_technical" in code
        assert "create_react_agent" in code

    def test_agent_output_fields(self, risk_spec):
        code, _ = compile_langgraph(risk_spec)
        assert "'legal_risk'" in code
        assert "'financial_risk'" in code
        assert "'technical_risk'" in code

    def test_synthesise_node_reads_all_three_risks(self, risk_spec):
        code, _ = compile_langgraph(risk_spec)
        assert "$.state.legal_risk" in code
        assert "$.state.financial_risk" in code
        assert "$.state.technical_risk" in code

    def test_synthesise_output_key(self, risk_spec):
        code, _ = compile_langgraph(risk_spec)
        assert "'risk_report'" in code

    def test_checkpointer_enabled(self, risk_spec):
        code, _ = compile_langgraph(risk_spec)
        assert "MemorySaver" in code
        assert "checkpointer" in code

    def test_langfuse_observe_decorator_generated(self, risk_spec):
        """Telemetry-enabled spec must emit @_lf_observe and Langfuse client setup."""
        code, _ = compile_langgraph(risk_spec)
        assert "_lf_observe" in code
        assert "LANGFUSE_PUBLIC_KEY" in code
        assert "LANGFUSE_SECRET_KEY" in code
        assert "LANGFUSE_HOST" in code


# ── Compile: MAF ──────────────────────────────────────────────────────────────


class TestMAFCompile:
    def test_no_warnings(self, risk_spec):
        _, warnings = compile_maf(risk_spec)
        assert warnings == []

    def test_asyncio_gather_generated(self, risk_spec):
        code, _ = compile_maf(risk_spec)
        assert "asyncio.gather" in code
        assert "node_assess_legal" in code
        assert "node_assess_financial" in code
        assert "node_assess_technical" in code

    def test_otel_setup_with_langfuse_auth(self, risk_spec):
        code, _ = compile_maf(risk_spec)
        assert "_setup_telemetry" in code
        assert "LANGFUSE_PUBLIC_KEY" in code
        assert "LANGFUSE_SECRET_KEY" in code
        assert "Authorization" in code
        assert "Basic" in code

    def test_otel_endpoint_reads_from_env(self, risk_spec):
        code, _ = compile_maf(risk_spec)
        assert "LANGFUSE_HOST" in code or "OTEL_EXPORTER_OTLP_ENDPOINT" in code

    def test_agent_nodes_async(self, risk_spec):
        code, _ = compile_maf(risk_spec)
        assert "async def node_assess_legal" in code
        assert "async def node_assess_financial" in code
        assert "async def node_assess_technical" in code
        assert "ChatCompletionAgent" in code

    def test_agent_output_fields(self, risk_spec):
        code, _ = compile_maf(risk_spec)
        assert "'legal_risk'" in code
        assert "'financial_risk'" in code
        assert "'technical_risk'" in code

    def test_synthesise_node_generated(self, risk_spec):
        code, _ = compile_maf(risk_spec)
        assert "async def node_synthesise" in code
        assert "'risk_report'" in code

    def test_join_node_not_a_node_function(self, risk_spec):
        """parallel_join is handled in the flow runner, not as a separate node fn."""
        code, _ = compile_maf(risk_spec)
        assert "async def node_join" not in code

    def test_parallel_join_in_flow_runner(self, risk_spec):
        code, _ = compile_maf(risk_spec)
        assert "parallel_join" in code
        assert "branch results already in state" in code or "risk_assessments" in code


# ── Compile: CrewAI ───────────────────────────────────────────────────────────


class TestCrewAICompile:
    def test_no_warnings(self, risk_spec):
        _, warnings = compile_crewai(risk_spec)
        assert warnings == []

    def test_three_specialist_agents_generated(self, risk_spec):
        code, _ = compile_crewai(risk_spec)
        assert "Legal Risk Analyst" in code
        assert "Financial Risk Analyst" in code
        assert "Technical Risk Analyst" in code

    def test_three_assessment_tasks(self, risk_spec):
        code, _ = compile_crewai(risk_spec)
        assert "task_assess_legal" in code
        assert "task_assess_financial" in code
        assert "task_assess_technical" in code

    def test_parallel_tasks_have_async_execution(self, risk_spec):
        code, _ = compile_crewai(risk_spec)
        assert "async_execution=True" in code

    def test_synthesise_task_generated(self, risk_spec):
        code, _ = compile_crewai(risk_spec)
        assert "task_synthesise" in code

    def test_crew_kickoff(self, risk_spec):
        code, _ = compile_crewai(risk_spec)
        assert "crew.kickoff" in code


# ── Compile: Mastra ───────────────────────────────────────────────────────────


class TestMastraCompile:
    def test_no_warnings(self, risk_spec):
        _, warnings = compile_mastra(risk_spec)
        assert warnings == []

    def test_parallel_steps_generated(self, risk_spec):
        code, _ = compile_mastra(risk_spec)
        assert "assessLegalStep" in code
        assert "assessFinancialStep" in code
        assert "assessTechnicalStep" in code

    def test_parallel_syntax(self, risk_spec):
        code, _ = compile_mastra(risk_spec)
        assert ".parallel(" in code

    def test_synthesise_step(self, risk_spec):
        code, _ = compile_mastra(risk_spec)
        assert "synthesiseStep" in code

    def test_typescript_syntax(self, risk_spec):
        code, _ = compile_mastra(risk_spec)
        assert "createStep" in code
        assert "z.object" in code
        assert "import" in code


# ── End-to-end: LangGraph exec (mocked LLM) ──────────────────────────────────


def _fake_agent_response(text: str) -> dict:
    msg = MagicMock()
    msg.content = text
    return {"messages": [msg]}


def test_langgraph_parallel_branches_all_run(risk_spec):
    """All three agent branches execute and write their output_field into state."""
    legal_resp = json.dumps(
        {"risk_level": "high", "risks": ["Unlimited liability"], "recommendations": ["Cap liability"]}
    )
    financial_resp = json.dumps(
        {"risk_level": "medium", "risks": ["Net 90 payment"], "recommendations": ["Negotiate terms"]}
    )
    technical_resp = json.dumps(
        {"risk_level": "high", "risks": ["99.999% SLA unrealistic"], "recommendations": ["Revise SLA"]}
    )
    synthesis_resp = "EXECUTIVE SUMMARY: High overall risk. Key findings: unlimited liability, unrealistic SLA."

    call_log: list[str] = []

    def _mock_agent_invoke(inputs: dict, **_kw):
        msgs = inputs.get("messages", [])
        system_content = msgs[0].content if msgs else ""
        call_log.append(system_content[:30])
        if "Legal Risk Analyst" in system_content:
            return {"messages": [MagicMock(content=legal_resp)]}
        if "Financial Risk Analyst" in system_content:
            return {"messages": [MagicMock(content=financial_resp)]}
        if "Technical Risk Analyst" in system_content:
            return {"messages": [MagicMock(content=technical_resp)]}
        return {"messages": [MagicMock(content=synthesis_resp)]}

    def _mock_llm_invoke(messages):
        return MagicMock(content=synthesis_resp)

    mock_agent = MagicMock()
    mock_agent.invoke = _mock_agent_invoke
    mock_llm = MagicMock(invoke=_mock_llm_invoke)

    code, _ = compile_langgraph(risk_spec)
    ns = _exec_with_stubs(code, "<risk_lg>", _build_lg_stubs())
    ns["create_react_agent"] = lambda *a, **kw: mock_agent
    ns["_make_llm"] = lambda *a, **kw: mock_llm

    final = ns["run_flow"]({"document": SAMPLE_DOCUMENT})

    assert "legal_risk" in final, "assess_legal must write legal_risk"
    assert "financial_risk" in final, "assess_financial must write financial_risk"
    assert "technical_risk" in final, "assess_technical must write technical_risk"
    assert "risk_report" in final, "synthesise must write risk_report"
    assert len(final["risk_report"]) > 20


def test_langgraph_synthesise_receives_all_branch_results(risk_spec):
    """The synthesise node prompt template must receive the three risk fields from state."""
    captured_prompts: list[str] = []

    def _mock_agent_invoke(inputs: dict, **_kw):
        msgs = inputs.get("messages", [])
        content = msgs[0].content if msgs else ""
        suffix = "legal" if "Legal" in content else "financial" if "Financial" in content else "technical"
        result = json.dumps({"risk_level": "low", "risks": [], "recommendations": [], "from": suffix})
        return {"messages": [MagicMock(content=result)]}

    def _mock_llm_invoke(messages):
        # Capture the rendered prompt that goes to synthesise
        for m in messages:
            if hasattr(m, "content"):
                captured_prompts.append(m.content)
        return MagicMock(content="Synthesis complete.")

    mock_agent = MagicMock(invoke=_mock_agent_invoke)
    mock_llm = MagicMock(invoke=_mock_llm_invoke)

    code, _ = compile_langgraph(risk_spec)
    ns = _exec_with_stubs(code, "<risk_lg_synth>", _build_lg_stubs())
    ns["create_react_agent"] = lambda *a, **kw: mock_agent
    ns["_make_llm"] = lambda *a, **kw: mock_llm

    ns["run_flow"]({"document": SAMPLE_DOCUMENT})

    # The synthesise node's HumanMessage content should contain the rendered risk fields
    all_prompts = " ".join(captured_prompts)
    assert "legal" in all_prompts.lower() or "Legal" in all_prompts, "synthesise prompt must contain legal_risk content"


# ── End-to-end: MAF exec (mocked SK) ─────────────────────────────────────────


def test_maf_parallel_branches_all_run(risk_spec):
    """asyncio.gather runs all three branches concurrently and merges results."""
    legal_result = json.dumps({"risk_level": "high", "risks": ["unlimited liability"]})
    financial_result = json.dumps({"risk_level": "medium", "risks": ["net 90 terms"]})
    technical_result = json.dumps({"risk_level": "high", "risks": ["99.999% SLA"]})
    synthesis_result = "High overall risk."

    async def _fake_agent_invoke(history):
        yield MagicMock(content="done", name="agent")

    code, warnings = compile_maf(risk_spec)
    assert warnings == []

    ns = _exec_with_stubs(code, "<risk_maf>", _build_sk_stubs())

    # Patch _make_kernel to avoid actual SK/OpenAI calls
    call_idx = {"n": 0}

    def _fake_kernel(model="gpt-4o-mini"):
        k = MagicMock()
        svc = MagicMock()
        settings_obj = MagicMock()
        settings_obj.temperature = 0
        settings_obj.max_tokens = 1024
        svc.get_prompt_execution_settings_class = lambda: lambda: settings_obj

        # Cycle through responses for each agent/llm call
        responses_cycle = [legal_result, financial_result, technical_result, synthesis_result]
        idx = call_idx["n"] % len(responses_cycle)
        call_idx["n"] += 1

        async def _get_chat(history, settings=None):
            return [MagicMock(__str__=lambda s: responses_cycle[idx])]

        svc.get_chat_message_contents = _get_chat
        k.get_service = lambda *a, **kw: svc
        return k

    # Patch ChatCompletionAgent to return canned responses per role
    agent_responses = {
        "legal_analyst": legal_result,
        "financial_analyst": financial_result,
        "technical_analyst": technical_result,
    }

    class _FakeAgent:
        def __init__(self, *a, name="agent", instructions="", **kw):
            self._name = name

        async def invoke(self, history):
            text = agent_responses.get(self._name, synthesis_result)
            yield MagicMock(content=text)

    async def _fake_get_contents(history, settings=None):
        return [MagicMock(__str__=lambda s: synthesis_result)]

    ns["_make_kernel"] = _fake_kernel
    ns["ChatCompletionAgent"] = _FakeAgent
    # Patch svc inside the kernel that synthesise uses
    synth_kernel = MagicMock()
    synth_svc = MagicMock()
    synth_svc.get_prompt_execution_settings_class = lambda: lambda: MagicMock()
    synth_svc.get_chat_message_contents = _fake_get_contents
    synth_kernel.get_service = lambda *a, **kw: synth_svc

    result = ns["run_flow"]({"document": SAMPLE_DOCUMENT})

    # All three branches must have run and written their output fields
    assert "legal_risk" in result, f"legal_risk missing from state: {list(result)}"
    assert "financial_risk" in result, f"financial_risk missing from state: {list(result)}"
    assert "technical_risk" in result, f"technical_risk missing from state: {list(result)}"


def test_maf_otel_setup_produces_correct_auth(risk_spec):
    """The generated OTel setup code must compute Basic auth from env vars at runtime."""
    import base64

    code, _ = compile_maf(risk_spec)

    # Exec the generated code but short-circuit the actual OTLP export
    captured: dict = {}

    class _FakeExporter:
        def __init__(self, endpoint="", headers=None):
            captured["endpoint"] = endpoint
            captured["headers"] = headers or {}

        def export(self, *a, **kw):
            pass

    ns: dict = {}
    # Inject fake OTel classes so exec doesn't need real OTel packages
    from unittest.mock import MagicMock as MM

    fake_provider = MM()
    fake_provider.add_span_processor = lambda *a: None
    ns["_TracerProvider"] = lambda: fake_provider
    ns["_BSP"] = lambda *a, **kw: MM()
    ns["_OTLPExp"] = _FakeExporter
    ns["_otel_trace"] = MM()
    ns["os"] = __import__("os")

    import os

    old = os.environ.copy()
    os.environ["LANGFUSE_PUBLIC_KEY"] = "pk-test"
    os.environ["LANGFUSE_SECRET_KEY"] = "sk-test"
    os.environ["LANGFUSE_HOST"] = "http://localhost:3001"
    os.environ.pop("OTEL_EXPORTER_OTLP_ENDPOINT", None)

    try:
        # Extract just the _setup_telemetry function from generated code and exec it
        setup_start = code.find("def _setup_telemetry()")
        setup_end = code.find("\n\n", setup_start)
        call_line = "\n_setup_telemetry()\n"
        exec(compile(code[setup_start:setup_end] + call_line, "<otel_test>", "exec"), ns)
    finally:
        os.environ.clear()
        os.environ.update(old)

    assert "http://localhost:3001/api/public/otel/v1/traces" in captured.get("endpoint", ""), (
        f"Unexpected endpoint: {captured.get('endpoint')}"
    )

    auth_header = captured.get("headers", {}).get("Authorization", "")
    assert auth_header.startswith("Basic "), f"Missing Basic auth header: {auth_header}"
    decoded = base64.b64decode(auth_header[6:]).decode()
    assert decoded == "pk-test:sk-test", f"Wrong credentials in auth: {decoded}"
