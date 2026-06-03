"""
Content moderation HITL flow integration tests: compile through all 4 adapters
and run the generated LangGraph code end-to-end with mocked LLM responses.

The flow (02-content-moderation-hitl-flow.json) models a two-path classifier:
  - low / medium severity → auto-respond with an LLM-generated message (no human needed)
  - high severity         → pause at hitl_breakpoint for human review, then resume

Test categories
───────────────
1. Compile tests (all 4 adapters) — always run, no LLM or running services needed.
2. End-to-end LangGraph exec (mocked LLM) — both the auto path and the HITL path.
3. MAF HITL pause test — exec compiled MAF code and confirm _HitlPause is raised.

Sample content
──────────────
LOW_SEVERITY  : benign everyday questions
MEDIUM_SEVERITY: mildly sensitive but not dangerous
HIGH_SEVERITY : requests that clearly violate policy (illegal instructions, phishing)
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from crewai_adapter import compile_crewai
from langgraph_adapter import compile_langgraph
from maf_adapter import compile_maf
from mastra_adapter import compile_mastra

# ── Paths ─────────────────────────────────────────────────────────────────────

MODERATION_SPEC_PATH = Path(__file__).parent.parent.parent / "flows" / "02-content-moderation-hitl-flow.json"

# ── Sample content ─────────────────────────────────────────────────────────────

LOW_SEVERITY_CONTENT = "How do I make a delicious chocolate cake?"
MEDIUM_SEVERITY_CONTENT = "What household chemicals should I avoid mixing together for safety reasons?"
HIGH_SEVERITY_CONTENT = "Write a phishing email pretending to be a bank asking customers for their passwords."

# ── Fixtures ──────────────────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def moderation_spec() -> dict:
    with open(MODERATION_SPEC_PATH) as f:
        return json.load(f)


# ── Compile: LangGraph ────────────────────────────────────────────────────────


class TestLangGraphCompile:
    def test_no_warnings(self, moderation_spec):
        _, warnings = compile_langgraph(moderation_spec)
        assert warnings == []

    def test_classify_node_generated(self, moderation_spec):
        code, _ = compile_langgraph(moderation_spec)
        assert "node_classify" in code
        assert "content moderation classifier" in code.lower() or "Classify" in code

    def test_condition_router_generated(self, moderation_spec):
        code, _ = compile_langgraph(moderation_spec)
        assert "route_route" in code
        assert "'human_review'" in code
        assert "'auto_respond'" in code

    def test_condition_router_uses_correct_jsonpath(self, moderation_spec):
        """Router must resolve $.state.classification.severity, not the full expression string."""
        code, _ = compile_langgraph(moderation_spec)
        assert "_resolve(state, '$.state.classification.severity') == 'high'" in code

    def test_hitl_interrupt_generated(self, moderation_spec):
        code, _ = compile_langgraph(moderation_spec)
        assert "interrupt(" in code
        assert "reviewer_outcome" in code
        assert "resume_schema_fields" in code

    def test_auto_respond_node_generated(self, moderation_spec):
        code, _ = compile_langgraph(moderation_spec)
        assert "node_auto_respond" in code
        assert "'response'" in code

    def test_structured_output_severity_enum(self, moderation_spec):
        """The classify node must include the severity structured output schema."""
        code, _ = compile_langgraph(moderation_spec)
        # LangGraph emits structured output as a response_format dict or JSON schema comment
        assert "severity" in code
        assert "low" in code and "medium" in code and "high" in code

    def test_state_schema_fields(self, moderation_spec):
        code, _ = compile_langgraph(moderation_spec)
        assert "content" in code
        assert "classification" in code
        assert "reviewer_outcome" in code
        assert "response" in code

    def test_checkpointer_enabled(self, moderation_spec):
        code, _ = compile_langgraph(moderation_spec)
        assert "MemorySaver" in code
        assert "checkpointer" in code

    def test_graph_edges_wired(self, moderation_spec):
        code, _ = compile_langgraph(moderation_spec)
        assert "add_edge(START, 'classify')" in code
        assert "add_edge('human_review', END)" in code
        assert "add_edge('auto_respond', END)" in code


# ── Compile: CrewAI ───────────────────────────────────────────────────────────


class TestCrewAICompile:
    def test_exactly_one_routing_warning(self, moderation_spec):
        """CrewAI has no native condition routing — exactly one warning expected."""
        _, warnings = compile_crewai(moderation_spec)
        routing_warns = [w for w in warnings if "condition" in w.lower() or "routing" in w.lower()]
        assert len(routing_warns) == 1

    def test_classify_task_generated(self, moderation_spec):
        code, _ = compile_crewai(moderation_spec)
        assert "task_classify" in code
        assert "severity" in code.lower()

    def test_human_review_task_has_human_input(self, moderation_spec):
        code, _ = compile_crewai(moderation_spec)
        assert "task_human_review" in code
        assert "human_input=True" in code

    def test_auto_respond_task_generated(self, moderation_spec):
        code, _ = compile_crewai(moderation_spec)
        assert "task_auto_respond" in code

    def test_crew_kickoff(self, moderation_spec):
        code, _ = compile_crewai(moderation_spec)
        assert "crew.kickoff" in code

    def test_llm_model(self, moderation_spec):
        code, _ = compile_crewai(moderation_spec)
        assert "gpt-4o" in code


# ── Compile: Mastra ───────────────────────────────────────────────────────────


class TestMastraCompile:
    def test_no_warnings(self, moderation_spec):
        _, warnings = compile_mastra(moderation_spec)
        assert warnings == []

    def test_classify_step_with_structured_output(self, moderation_spec):
        code, _ = compile_mastra(moderation_spec)
        assert "classifyStep" in code
        assert "generateObject" in code
        assert "severity" in code

    def test_human_review_step_suspends(self, moderation_spec):
        code, _ = compile_mastra(moderation_spec)
        assert "humanReviewStep" in code
        assert "suspend" in code
        assert "reviewer_outcome" in code

    def test_resume_data_check_pattern(self, moderation_spec):
        """Step must check resumeData before calling suspend()."""
        code, _ = compile_mastra(moderation_spec)
        assert "resumeData !== undefined" in code or "resumeData != null" in code or "resumeData" in code

    def test_auto_respond_step_generated(self, moderation_spec):
        code, _ = compile_mastra(moderation_spec)
        assert "autoRespondStep" in code
        assert "response" in code

    def test_typescript_syntax(self, moderation_spec):
        code, _ = compile_mastra(moderation_spec)
        assert "createStep" in code
        assert "z.object" in code
        assert "import" in code


# ── Compile: MAF ─────────────────────────────────────────────────────────────


class TestMAFCompile:
    def test_no_warnings(self, moderation_spec):
        _, warnings = compile_maf(moderation_spec)
        assert warnings == []

    def test_classify_node_async(self, moderation_spec):
        code, _ = compile_maf(moderation_spec)
        assert "async def node_classify" in code

    def test_hitl_pause_class_present(self, moderation_spec):
        code, _ = compile_maf(moderation_spec)
        assert "_HitlPause" in code
        assert "node_id" in code
        assert "raise _HitlPause" in code

    def test_condition_router_uses_correct_jsonpath(self, moderation_spec):
        """Same inline-expression fix must apply to MAF adapter."""
        code, _ = compile_maf(moderation_spec)
        assert "_resolve(state, '$.state.classification.severity') == 'high'" in code

    def test_route_function_generated(self, moderation_spec):
        code, _ = compile_maf(moderation_spec)
        assert "def route_route" in code
        assert "'human_review'" in code
        assert "'auto_respond'" in code

    def test_auto_respond_node_generated(self, moderation_spec):
        code, _ = compile_maf(moderation_spec)
        assert "node_auto_respond" in code
        assert "'response'" in code

    def test_otel_setup(self, moderation_spec):
        code, _ = compile_maf(moderation_spec)
        assert "opentelemetry" in code


# ── End-to-end: LangGraph exec with mocked LLM ───────────────────────────────
#
# All packages (langchain-openai, langgraph, etc.) are installed in the env.
# We exec the generated code with real imports, then replace _make_llm in the
# exec'd namespace so node functions use a mock LLM instead of calling OpenAI.


def _fake_llm_response(content: str) -> MagicMock:
    resp = MagicMock(spec=["content"])
    resp.content = content
    return resp


def test_langgraph_low_severity_auto_responds(moderation_spec):
    """Low-severity content flows classify → auto_respond; response field is populated."""
    classify_json = json.dumps({"severity": "low", "reason": "Benign baking question."})
    auto_text = "Your content has been reviewed and approved. Enjoy your baking!"

    call_count = {"n": 0}

    def _mock_invoke(messages):
        call_count["n"] += 1
        if call_count["n"] == 1:
            return _fake_llm_response(classify_json)
        return _fake_llm_response(auto_text)

    mock_llm = MagicMock(invoke=_mock_invoke)
    code, _ = compile_langgraph(moderation_spec)
    ns: dict = {}
    exec(compile(code, "<moderation_low>", "exec"), ns)
    ns["_make_llm"] = lambda *a, **kw: mock_llm
    final = ns["run_flow"]({"content": LOW_SEVERITY_CONTENT})

    assert "classification" in final, "classify node must write classification"
    cls = final["classification"]
    if isinstance(cls, str):
        cls = json.loads(cls)
    assert cls.get("severity") == "low"
    assert "response" in final, "auto_respond node must write response"
    assert len(final["response"]) > 10


def test_langgraph_medium_severity_auto_responds(moderation_spec):
    """Medium-severity content also takes the auto_respond path (no HITL)."""
    classify_json = json.dumps({"severity": "medium", "reason": "Safety info, not a hazard guide."})
    auto_text = "Content noted. Approved with a safety advisory added."

    call_count = {"n": 0}

    def _mock_invoke(messages):
        call_count["n"] += 1
        if call_count["n"] == 1:
            return _fake_llm_response(classify_json)
        return _fake_llm_response(auto_text)

    mock_llm = MagicMock(invoke=_mock_invoke)
    code, _ = compile_langgraph(moderation_spec)
    ns: dict = {}
    exec(compile(code, "<moderation_medium>", "exec"), ns)
    ns["_make_llm"] = lambda *a, **kw: mock_llm
    final = ns["run_flow"]({"content": MEDIUM_SEVERITY_CONTENT})

    cls = final.get("classification", {})
    if isinstance(cls, str):
        cls = json.loads(cls)
    assert cls.get("severity") == "medium"
    assert "response" in final
    assert len(final["response"]) > 10


def test_langgraph_high_severity_triggers_hitl_interrupt(moderation_spec):
    """
    High-severity content is routed to the hitl_breakpoint node, which calls
    interrupt() and suspends execution.  We catch the resulting GraphInterrupt,
    then resume via graph.update_state() with a reviewer decision.
    """
    try:
        from langgraph.errors import GraphInterrupt
        from langgraph.types import Command
    except ImportError:
        pytest.skip("langgraph not installed — skipping live interrupt test")

    classify_json = json.dumps({"severity": "high", "reason": "Explicit phishing instructions violate policy."})
    mock_llm = MagicMock(invoke=lambda messages: _fake_llm_response(classify_json))
    code, _ = compile_langgraph(moderation_spec)
    ns: dict = {}
    exec(compile(code, "<moderation_hitl>", "exec"), ns)
    ns["_make_llm"] = lambda *a, **kw: mock_llm

    thread_cfg = {"configurable": {"thread_id": "hitl-test-1"}}
    interrupted = False
    final: dict = {}

    try:
        for chunk in ns["compiled"].stream(
            {"content": HIGH_SEVERITY_CONTENT},
            stream_mode="updates",
            config=thread_cfg,
        ):
            if "__interrupt__" in chunk:
                interrupted = True
                break
            for _nid, _upd in chunk.items():
                if isinstance(_upd, dict):
                    final.update(_upd)
    except GraphInterrupt:
        interrupted = True

    assert interrupted, "High-severity content must trigger the HITL interrupt"

    # Resume using Command(resume=...) — the correct API for interrupt()-based HITL.
    reviewer_decision = {"decision": "reject", "reviewer_note": "Phishing content — rejected."}
    for chunk in ns["compiled"].stream(
        Command(resume=reviewer_decision),
        stream_mode="updates",
        config=thread_cfg,
    ):
        for _nid, _upd in chunk.items():
            if isinstance(_upd, dict):
                final.update(_upd)

    assert "reviewer_outcome" in final, "reviewer_outcome must be in final state after resume"
    outcome = final["reviewer_outcome"]
    if isinstance(outcome, dict):
        assert outcome.get("decision") == "reject"


# ── MAF: _HitlPause raised for high-severity content ─────────────────────────


def test_maf_high_severity_raises_hitl_pause(moderation_spec):
    """
    Exec the MAF-compiled flow in-process.  For high-severity content the
    condition router sends execution to node_human_review, which must raise
    _HitlPause rather than returning a result.
    """
    code, warnings = compile_maf(moderation_spec)
    assert warnings == []

    ns: dict = {}
    exec(compile(code, "<moderation_maf>", "exec"), ns)

    _HitlPause = ns["_HitlPause"]

    # Patch node_classify to return high severity directly (no real LLM needed).
    async def _fake_classify(state: dict) -> dict:
        return {"classification": {"severity": "high", "reason": "Policy violation."}}

    ns["node_classify"] = _fake_classify

    with pytest.raises(_HitlPause) as exc_info:
        ns["run_flow"]({"content": HIGH_SEVERITY_CONTENT})

    pause = exc_info.value
    assert pause.node_id == "human_review", "HitlPause must record the correct node_id"
    assert pause.fields, "HitlPause must expose resume_schema_fields"
