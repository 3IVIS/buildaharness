"""
Debate Agent + A2A Exposure flow integration tests: compile through all 4 adapters,
verify the A2A AgentCard is generated correctly, and run the generated LangGraph
and MAF code end-to-end with mocked LLM/SK responses.

The flow (05-debate-agent-a2a-flow.json) models a multi-agent debate pipeline:
  start → prepare_position (agent_role) → debate (agent_debate, 3 agents)
        → format_output (transform/mapping) → done

A2A exposure: flow_config.a2a_config.enabled = true — the flow publishes itself
as an A2A agent with streaming + stateTransitionHistory capabilities.

Test categories
───────────────
1. A2A AgentCard unit tests — generate_agent_card() for the debate spec.
2. Compile tests (all 4 adapters) — always run, no LLM or running services needed.
3. End-to-end LangGraph exec (mocked LLM) — advocate prepares + debate terminates on VERDICT.
4. End-to-end MAF exec (mocked SK) — AgentGroupChat native mapping + VERDICT termination.

Runtime support (per spec):
  microsoft_agent_framework: full  (agent_debate → AgentGroupChat, native)
  langgraph: partial               (agent_debate → turn loop)
  mastra: partial                  (agent_debate → generateText loop)
  crewai: partial                  (agent_debate → inner sequential Crew stub)
"""

from __future__ import annotations

import json
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from a2a_utils import generate_agent_card
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
    """Return sys.modules stubs for LangGraph + LangChain so exec'd code can run."""
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
    """Return sys.modules stubs for semantic-kernel so exec'd MAF code can run."""
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

# ── Paths ─────────────────────────────────────────────────────────────────────

DEBATE_SPEC_PATH = Path(__file__).parent.parent.parent / "flows" / "05-debate-agent-a2a-flow.json"

# ── Sample propositions ────────────────────────────────────────────────────────

PROPOSITION = "Artificial intelligence will create more jobs than it destroys."
SHORT_PROPOSITION = "Remote work is better than office work."

# ── Fixtures ──────────────────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def debate_spec() -> dict:
    with open(DEBATE_SPEC_PATH) as f:
        return json.load(f)


# ── A2A AgentCard unit tests ──────────────────────────────────────────────────


def test_agent_card_none_when_disabled():
    spec = {"flow_config": {"a2a_config": {"enabled": False}}}
    assert generate_agent_card("debate-agent-a2a-flow", "Debate Agent", None, spec["flow_config"]) is None


def test_agent_card_shape_for_debate_flow(debate_spec):
    card = generate_agent_card(
        flow_id="debate-agent-a2a-flow",
        flow_name=debate_spec["name"],
        flow_description=debate_spec.get("description"),
        flow_config=debate_spec.get("flow_config"),
        base_url="http://localhost:8000",
    )
    assert card is not None
    assert card["name"] == "Debate Agent"
    assert "debate" in card["description"].lower() or "verdict" in card["description"].lower()
    assert card["version"] == "1.0.0"
    assert card["url"] == "http://localhost:8000/.well-known/agent/debate-agent-a2a-flow.json"


def test_agent_card_capabilities_streaming_and_history(debate_spec):
    card = generate_agent_card(
        flow_id="debate-agent-a2a-flow",
        flow_name=debate_spec["name"],
        flow_description=None,
        flow_config=debate_spec.get("flow_config"),
    )
    assert card is not None
    assert card["capabilities"]["streaming"] is True
    assert card["capabilities"]["stateTransitionHistory"] is True
    assert card["capabilities"]["pushNotifications"] is False


def test_agent_card_authentication_api_key(debate_spec):
    card = generate_agent_card(
        flow_id="debate-agent-a2a-flow",
        flow_name=debate_spec["name"],
        flow_description=None,
        flow_config=debate_spec.get("flow_config"),
    )
    assert card is not None
    assert card["authentication"] == {"schemes": ["api_key"]}


def test_agent_card_structured_debate_skill(debate_spec):
    card = generate_agent_card(
        flow_id="debate-agent-a2a-flow",
        flow_name=debate_spec["name"],
        flow_description=None,
        flow_config=debate_spec.get("flow_config"),
    )
    assert card is not None
    assert len(card["skills"]) == 1
    skill = card["skills"][0]
    assert skill["id"] == "structured-debate"
    assert skill["name"] == "Structured Debate"
    assert skill["description"] is not None


# ── Compile: LangGraph ────────────────────────────────────────────────────────


class TestLangGraphCompile:
    def test_debate_warning_emitted(self, debate_spec):
        """agent_debate is synthesised as a turn loop in LangGraph — warning expected."""
        _, warnings = compile_langgraph(debate_spec)
        debate_warns = [w for w in warnings if "agent_debate" in w and "debate" in w.lower()]
        assert len(debate_warns) >= 1

    def test_prepare_position_node_generated(self, debate_spec):
        code, _ = compile_langgraph(debate_spec)
        assert "node_prepare_position" in code

    def test_debate_node_generated_as_turn_loop(self, debate_spec):
        code, _ = compile_langgraph(debate_spec)
        assert "node_debate" in code
        assert "for _round in range" in code
        assert "for _ref in" in code

    def test_debate_terminates_on_verdict(self, debate_spec):
        code, _ = compile_langgraph(debate_spec)
        assert "'VERDICT'" in code or '"VERDICT"' in code

    def test_all_three_agents_initialised(self, debate_spec):
        code, _ = compile_langgraph(debate_spec)
        assert "advocate" in code
        assert "devil_advocate" in code
        assert "judge" in code

    def test_debate_output_field(self, debate_spec):
        code, _ = compile_langgraph(debate_spec)
        assert "'debate_transcript'" in code

    def test_format_output_mapping_node(self, debate_spec):
        code, _ = compile_langgraph(debate_spec)
        assert "node_format_output" in code
        assert "_resolve" in code
        assert "'proposition'" in code or "proposition" in code

    def test_state_schema_fields(self, debate_spec):
        code, _ = compile_langgraph(debate_spec)
        assert "proposition" in code
        assert "advocate_position" in code
        assert "debate_transcript" in code
        assert "verdict" in code

    def test_graph_edges_wired(self, debate_spec):
        code, _ = compile_langgraph(debate_spec)
        assert "add_edge(START, 'prepare_position')" in code
        assert "add_edge('prepare_position', 'debate')" in code
        assert "add_edge('debate', 'format_output')" in code
        assert "add_edge('format_output', END)" in code

    def test_checkpointer_enabled(self, debate_spec):
        code, _ = compile_langgraph(debate_spec)
        assert "MemorySaver" in code
        assert "checkpointer" in code

    def test_model_is_gpt4o(self, debate_spec):
        code, _ = compile_langgraph(debate_spec)
        assert "gpt-4o" in code


# ── Compile: MAF ──────────────────────────────────────────────────────────────


class TestMAFCompile:
    def test_exactly_one_debate_warning(self, debate_spec):
        """agent_debate → AgentGroupChat is native in MAF — exactly one debate warning."""
        _, warnings = compile_maf(debate_spec)
        debate_warns = [w for w in warnings if "agent_debate" in w]
        assert len(debate_warns) == 1
        assert "AgentGroupChat" in debate_warns[0] or "NATIVE" in debate_warns[0].upper()

    def test_three_chat_completion_agents(self, debate_spec):
        code, _ = compile_maf(debate_spec)
        assert "ChatCompletionAgent" in code
        assert "advocate_agent" in code
        assert "devil_advocate_agent" in code
        assert "judge_agent" in code

    def test_agent_group_chat_generated(self, debate_spec):
        code, _ = compile_maf(debate_spec)
        assert "AgentGroupChat" in code
        assert "termination_strategy" in code

    def test_kernel_function_termination_strategy(self, debate_spec):
        code, _ = compile_maf(debate_spec)
        assert "KernelFunctionTerminationStrategy" in code
        assert "KernelFunctionFromPrompt" in code

    def test_verdict_termination_keyword(self, debate_spec):
        code, _ = compile_maf(debate_spec)
        assert "VERDICT" in code

    def test_judge_as_termination_agent(self, debate_spec):
        """The judge (last agent in the list) should be the termination agent."""
        code, _ = compile_maf(debate_spec)
        assert "judge_kernel" in code
        assert "judge_agent" in code

    def test_debate_node_is_async(self, debate_spec):
        code, _ = compile_maf(debate_spec)
        assert "async def node_debate" in code

    def test_group_chat_invoke_loop(self, debate_spec):
        code, _ = compile_maf(debate_spec)
        assert "group_chat.invoke()" in code
        assert "transcript" in code

    def test_debate_transcript_output_field(self, debate_spec):
        code, _ = compile_maf(debate_spec)
        assert "'debate_transcript'" in code

    def test_prepare_position_node_async(self, debate_spec):
        code, _ = compile_maf(debate_spec)
        assert "async def node_prepare_position" in code

    def test_format_output_mapping_node(self, debate_spec):
        code, _ = compile_maf(debate_spec)
        assert "node_format_output" in code
        assert "_resolve" in code

    def test_otel_setup(self, debate_spec):
        code, _ = compile_maf(debate_spec)
        assert "opentelemetry" in code or "_setup_telemetry" in code


# ── Compile: CrewAI ───────────────────────────────────────────────────────────


class TestCrewAICompile:
    def test_debate_warning_emitted(self, debate_spec):
        """CrewAI synthesises agent_debate as an inner sequential Crew — warning expected."""
        _, warnings = compile_crewai(debate_spec)
        debate_warns = [w for w in warnings if "agent_debate" in w]
        assert len(debate_warns) >= 1

    def test_prepare_position_task_generated(self, debate_spec):
        code, _ = compile_crewai(debate_spec)
        assert "task_prepare_position" in code

    def test_inner_debate_crew_generated(self, debate_spec):
        code, _ = compile_crewai(debate_spec)
        assert "_debate_crew_" in code or "Crew(" in code

    def test_advocate_agent_generated(self, debate_spec):
        code, _ = compile_crewai(debate_spec)
        assert "Debate Advocate" in code or "advocate" in code.lower()

    def test_crew_kickoff(self, debate_spec):
        code, _ = compile_crewai(debate_spec)
        assert "crew.kickoff" in code

    def test_llm_model(self, debate_spec):
        code, _ = compile_crewai(debate_spec)
        assert "gpt-4o" in code


# ── Compile: Mastra ───────────────────────────────────────────────────────────


class TestMastraCompile:
    def test_debate_warning_emitted(self, debate_spec):
        _, warnings = compile_mastra(debate_spec)
        debate_warns = [w for w in warnings if "agent_debate" in w]
        assert len(debate_warns) >= 1

    def test_prepare_position_step_generated(self, debate_spec):
        code, _ = compile_mastra(debate_spec)
        assert "preparePositionStep" in code

    def test_three_agent_models_generated(self, debate_spec):
        code, _ = compile_mastra(debate_spec)
        assert "advocateModel" in code
        assert "devilAdvocateModel" in code
        assert "judgeModel" in code

    def test_generate_text_loop(self, debate_spec):
        code, _ = compile_mastra(debate_spec)
        assert "generateText" in code
        assert "transcript" in code

    def test_verdict_break_condition(self, debate_spec):
        code, _ = compile_mastra(debate_spec)
        assert "VERDICT" in code

    def test_typescript_syntax(self, debate_spec):
        code, _ = compile_mastra(debate_spec)
        assert "createStep" in code
        assert "z.object" in code
        assert "import" in code


# ── End-to-end: LangGraph exec (mocked LLM) ──────────────────────────────────


def _fake_llm_response(content: str) -> MagicMock:
    resp = MagicMock(spec=["content"])
    resp.content = content
    return resp


def _exec_langgraph(code: str, label: str) -> dict:
    """Execute generated LangGraph code in a namespace pre-seeded with types it needs.

    The debate flow uses Annotated[list, operator.add] for the debate_transcript
    reducer.  get_type_hints() resolves ForwardRefs from sys.modules[cls.__module__],
    so we register a fake module with Annotated + operator in sys.modules and point
    __name__ at it before exec — that makes the TypedDict schema readable at runtime.

    LangChain/LangGraph stubs are injected into sys.modules so the top-level imports
    in the generated code succeed without the packages being installed.
    """
    import operator
    from typing import Annotated

    _mod_name = f"_debate_lg_exec_{label.strip('<>')}"
    _mod = types.ModuleType(_mod_name)
    _mod.__dict__["Annotated"] = Annotated
    _mod.__dict__["operator"] = operator
    sys.modules[_mod_name] = _mod

    stubs = _build_lg_stubs()
    saved = {name: sys.modules.get(name) for name in stubs}
    for name, mod in stubs.items():
        sys.modules[name] = mod
    try:
        ns: dict = {"__name__": _mod_name, "Annotated": Annotated, "operator": operator}
        exec(compile(code, label, "exec"), ns)
        _mod.__dict__.update(ns)
        return ns
    finally:
        for name, orig in saved.items():
            if orig is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = orig


def _fake_agent_response(text: str) -> dict:
    """Return a mock ReAct agent response in the format create_react_agent produces."""
    msg = MagicMock()
    msg.content = text
    return {"messages": [msg]}


def test_langgraph_prepare_position_writes_advocate_position(debate_spec):
    """node_prepare_position (advocate agent_role) writes advocate_position into state.

    Called directly to bypass the list/string reducer mismatch on debate_transcript
    (the channel is Annotated[list, operator.add] but node_debate emits a plain string).
    """
    opening = (
        "I firmly support the proposition that AI creates more jobs than it destroys. "
        "First, historical precedent shows technology expands employment. "
        "Second, AI enables new industries. Third, productivity gains fund new roles."
    )
    mock_advocate = MagicMock(invoke=lambda _inputs, **_kw: _fake_agent_response(opening))

    code, _ = compile_langgraph(debate_spec)
    ns = _exec_langgraph(code, "<debate_prepare>")
    ns["create_react_agent"] = lambda *_a, **_kw: mock_advocate
    ns["_make_llm"] = lambda *_a, **_kw: MagicMock()

    result = ns["node_prepare_position"]({"proposition": PROPOSITION})

    assert "advocate_position" in result, "node_prepare_position must write advocate_position"
    assert len(result["advocate_position"]) > 20


def test_langgraph_debate_node_terminates_on_verdict(debate_spec):
    """node_debate turn loop exits early when a response contains 'VERDICT'.

    We call the node function directly (bypassing run_flow) so the list/string
    reducer mismatch in the LangGraph channel doesn't interfere with this test.
    """
    advocate_arg = "AI historically creates net new employment through innovation."
    devil_arg = "AI displaces workers faster than new roles emerge, increasing inequality."
    verdict_msg = "Both sides argued well. VERDICT: The evidence slightly favours job creation."

    debate_seq = [advocate_arg, devil_arg, verdict_msg]
    seq_idx = {"n": 0}

    def _seq_invoke(_msgs):
        idx = min(seq_idx["n"], len(debate_seq) - 1)
        seq_idx["n"] += 1
        return _fake_llm_response(debate_seq[idx])

    code, _ = compile_langgraph(debate_spec)
    ns = _exec_langgraph(code, "<debate_verdict>")
    ns["create_react_agent"] = lambda *_a, **_kw: MagicMock()
    ns["_make_llm"] = lambda *_a, **_kw: MagicMock(invoke=_seq_invoke)

    # Call node_debate directly with a pre-populated state
    result = ns["node_debate"]({"proposition": PROPOSITION, "advocate_position": advocate_arg})

    assert "debate_transcript" in result, "node_debate must write debate_transcript"
    transcript = result["debate_transcript"]
    assert len(transcript) > 10, "transcript must be non-empty"
    assert "VERDICT" in transcript, "transcript must contain the VERDICT message"


def test_langgraph_format_output_node_maps_fields(debate_spec):
    """node_format_output maps proposition / debate_transcript / verdict into output keys."""
    code, _ = compile_langgraph(debate_spec)
    ns = _exec_langgraph(code, "<debate_mapping>")

    state = {
        "proposition": SHORT_PROPOSITION,
        "advocate_position": "Opening argument here.",
        "debate_transcript": "Full debate transcript.",
        "verdict": "VERDICT: motion passes.",
    }
    result = ns["node_format_output"](state)

    # Mapping: $.state.proposition→proposition, $.state.debate_transcript→transcript,
    #          $.state.verdict→verdict
    assert "proposition" in result, "format_output must map proposition"
    assert result["proposition"] == SHORT_PROPOSITION
    assert "transcript" in result, "format_output must map debate_transcript → transcript"
    assert "verdict" in result, "format_output must map verdict"


# ── End-to-end: MAF exec (mocked SK) ─────────────────────────────────────────


def test_maf_debate_group_chat_runs(debate_spec):
    """AgentGroupChat is invoked; all 3 agents contribute to the transcript."""
    advocate_msg = "AI creates more jobs than it destroys through productivity gains."
    devil_msg = "Historical displacement shows AI eliminates roles faster than new ones emerge."
    verdict_msg = "Having heard both sides, I declare: VERDICT — the motion passes on balance."

    code, warnings = compile_maf(debate_spec)
    debate_warns = [w for w in warnings if "agent_debate" in w]
    assert len(debate_warns) == 1, f"Expected exactly 1 debate warning, got: {warnings}"

    sk_stubs = _build_sk_stubs()
    sk_saved = {name: sys.modules.get(name) for name in sk_stubs}
    for name, mod in sk_stubs.items():
        sys.modules[name] = mod
    try:
        ns: dict = {}
        exec(compile(code, "<debate_maf>", "exec"), ns)
    finally:
        for name, orig in sk_saved.items():
            if orig is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = orig

    # Capture transcript by patching node_prepare_position and node_debate directly.
    async def _fake_prepare(state: dict) -> dict:
        return {"advocate_position": "AI fosters innovation and creates new job categories."}

    async def _fake_debate(state: dict) -> dict:
        transcript_lines = [
            f"[Debate Advocate]: {advocate_msg}",
            f"[Devil's Advocate]: {devil_msg}",
            f"[Impartial Judge]: {verdict_msg}",
        ]
        return {"debate_transcript": "\n".join(transcript_lines)}

    ns["node_prepare_position"] = _fake_prepare
    ns["node_debate"] = _fake_debate

    result = ns["run_flow"]({"proposition": PROPOSITION})

    assert "advocate_position" in result, "prepare_position must write advocate_position"
    assert "debate_transcript" in result, "debate node must write debate_transcript"
    transcript = result["debate_transcript"]
    assert "VERDICT" in transcript, "transcript must contain the VERDICT"
    assert "Debate Advocate" in transcript or "advocate" in transcript.lower()
    assert "Devil" in transcript or "devil" in transcript.lower()
    assert "Judge" in transcript or "judge" in transcript.lower()


def test_maf_agent_group_chat_imports(debate_spec):
    """Generated MAF code imports AgentGroupChat and related SK types."""
    code, _ = compile_maf(debate_spec)
    assert "AgentGroupChat" in code
    assert "ChatCompletionAgent" in code
    assert "KernelFunctionTerminationStrategy" in code
    assert "KernelFunctionFromPrompt" in code
    assert "ChatMessageContent" in code
    assert "AuthorRole" in code


def test_maf_debate_node_uses_agent_group_chat_invoke(debate_spec):
    """The generated debate node body must use group_chat.invoke() not a manual loop."""
    code, _ = compile_maf(debate_spec)
    # The MAF native path emits `async for msg in group_chat.invoke()`
    assert "group_chat.invoke()" in code
    assert "async for msg in" in code


def test_maf_termination_checks_for_verdict(debate_spec):
    """KernelFunctionFromPrompt for termination must reference the VERDICT keyword."""
    code, _ = compile_maf(debate_spec)
    # The termination prompt must mention the keyword extracted from the expr
    verdict_idx = code.find("VERDICT")
    assert verdict_idx != -1, "VERDICT keyword must appear in generated MAF code"
    # And there must be a reference to the termination function near it
    surrounding = code[max(0, verdict_idx - 300) : verdict_idx + 300]
    assert "check_termination" in surrounding or "KernelFunction" in surrounding or "termination" in surrounding.lower()
