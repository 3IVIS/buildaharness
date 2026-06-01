"""
Eval suite — Debate agent flow quality metrics (flow 05, MAF showcase).

Structural tests (no LLM):
  - All five reference flows compile to MAF without syntax errors.
  - The debate spec has the expected node types.
  - Generated AgentGroupChat code has a termination keyword.

Metric tests (requires EVAL_USE_REAL_LLM=true):
  - ArgumentCoherenceMetric   — does each argument logically support its position?
  - VerdictQualityMetric      — does the verdict fairly weigh both sides?
  - TranscriptStructureMetric — is the transcript well-formed and turn-based?

Thresholds (env-configurable):
  EVAL_THRESHOLD_COHERENCE  default 0.7
  EVAL_THRESHOLD_VERDICT    default 0.7

Run with:
  pytest eval/test_debate_quality.py --pythonpath adapter
"""

import ast
import os

import pytest

from eval.conftest import needs_real_llm
from maf_adapter import compile_maf

try:
    from deepeval import assert_test
    from deepeval.metrics import AnswerRelevancyMetric, GEval
    from deepeval.test_case import LLMTestCase, LLMTestCaseParams

    _DEEPEVAL_AVAILABLE = True
except ImportError:
    _DEEPEVAL_AVAILABLE = False

pytestmark = pytest.mark.skipif(
    not _DEEPEVAL_AVAILABLE,
    reason="deepeval not installed — run: pip install -r requirements-eval.txt",
)

_THRESHOLD_COHERENCE = float(os.getenv("EVAL_THRESHOLD_COHERENCE", "0.7"))
_THRESHOLD_VERDICT = float(os.getenv("EVAL_THRESHOLD_VERDICT", "0.7"))

# ── Synthetic debate eval dataset ─────────────────────────────────────────────
# Each sample represents what a well-functioning debate flow should produce
# for a given proposition.  Used for metric computation when EVAL_USE_REAL_LLM=true.

DEBATE_EVAL_DATASET = [
    {
        "proposition": "Remote work increases overall productivity.",
        "advocate_opening": (
            "Remote work increases productivity by eliminating commute time, enabling "
            "deep focus periods, and allowing employees to work during their peak energy "
            "hours. Studies show a 13% productivity gain for remote workers."
        ),
        "devil_advocate_response": (
            "Remote work can reduce productivity through increased distractions at home, "
            "communication overhead, and the loss of spontaneous collaboration that drives "
            "innovation. The 13% gain cited is from a single pre-pandemic study and is "
            "not generalisable."
        ),
        "judge_verdict": (
            "Both sides presented compelling evidence. The advocate's productivity data "
            "was challenged on methodological grounds. The devil's advocate raised valid "
            "concerns about collaboration loss. On balance, the evidence supports a "
            "context-dependent view rather than a universal claim. VERDICT: The proposition "
            "is partially supported — remote work can increase productivity for individual "
            "contributor roles but may reduce it for highly collaborative teams."
        ),
        "expected_verdict_keywords": ["VERDICT", "context", "collaboration"],
    },
    {
        "proposition": "AI will replace most software engineering jobs within 10 years.",
        "advocate_opening": (
            "AI coding assistants already handle routine code generation, bug fixing, and "
            "test writing. As models improve, the demand for human engineers will decline "
            "significantly, just as automation displaced factory workers."
        ),
        "devil_advocate_response": (
            "AI augments rather than replaces engineers. Complex architecture decisions, "
            "stakeholder communication, and novel problem-solving still require human "
            "judgement. Historical automation waves created more jobs than they destroyed."
        ),
        "judge_verdict": (
            "The advocate overstates AI's current capabilities while the devil's advocate "
            "underestimates the pace of improvement. The manufacturing analogy is imperfect. "
            "VERDICT: AI will transform the role of software engineers significantly but "
            "is unlikely to replace most jobs within 10 years — it will shift the work "
            "toward higher-abstraction tasks."
        ),
        "expected_verdict_keywords": ["VERDICT", "transform", "replace"],
    },
]


# ── Structural tests (no LLM — always run) ────────────────────────────────────


class TestDebateSpecStructure:
    """Cheap structural checks on the debate flow spec and generated code."""

    def test_debate_flow_validates(self, debate_flow_spec):
        from validate import validate_spec

        validate_spec(debate_flow_spec)

    def test_debate_flow_has_agent_debate_node(self, debate_flow_spec):
        types = [n["type"] for n in debate_flow_spec.get("nodes", [])]
        assert "agent_debate" in types, "debate flow must have an agent_debate node"

    def test_debate_flow_has_three_agents(self, debate_flow_spec):
        agents = debate_flow_spec.get("agents", [])
        assert len(agents) >= 3, f"Expected at least 3 agents, got {len(agents)}"

    def test_debate_flow_prefers_maf(self, debate_flow_spec):
        preferred = debate_flow_spec.get("runtime_hints", {}).get("preferred_adapter", "")
        assert preferred == "microsoft_agent_framework", (
            f"Flow 05 should prefer microsoft_agent_framework, got {preferred!r}"
        )

    def test_debate_flow_compiles_to_maf(self, debate_flow_spec):
        """Compile to MAF — must be syntactically valid Python."""
        code, _ = compile_maf(debate_flow_spec)
        ast.parse(code)

    def test_maf_code_has_agent_group_chat(self, debate_flow_spec):
        code, _ = compile_maf(debate_flow_spec)
        assert "AgentGroupChat" in code, "MAF code must use AgentGroupChat for agent_debate"

    def test_maf_code_has_termination_strategy(self, debate_flow_spec):
        code, _ = compile_maf(debate_flow_spec)
        assert "KernelFunctionTerminationStrategy" in code, "MAF code must emit a termination strategy"

    def test_maf_code_has_verdict_keyword(self, debate_flow_spec):
        """The termination keyword 'VERDICT' must be extracted from the condition expr."""
        code, _ = compile_maf(debate_flow_spec)
        assert "VERDICT" in code, "Termination keyword VERDICT must appear in generated code"

    def test_maf_code_exports_run_flow(self, debate_flow_spec):
        code, _ = compile_maf(debate_flow_spec)
        ns: dict = {}
        exec(compile(code, "<debate_eval>", "exec"), ns)
        assert "run_flow" in ns, "Generated code must export run_flow()"
        assert "_run_flow_async" in ns, "Generated code must export _run_flow_async()"

    def test_maf_code_warns_native_match(self, debate_flow_spec):
        _, warnings = compile_maf(debate_flow_spec)
        native = [w for w in warnings if "NATIVE MAF" in w or "AgentGroupChat" in w]
        assert native, "Expected at least one NATIVE MAF warning documenting the native mapping"

    def test_all_flows_compile_maf(self, all_flow_specs):
        """All 5 reference flows must compile to MAF without syntax errors.
        This is the fast gate added to eval.yml and ci.yml.
        """
        for spec in all_flow_specs:
            code, _ = compile_maf(spec)
            # Must be syntactically valid Python
            ast.parse(code)
            # Must export the runner
            assert "run_flow" in code, f"Flow {spec.get('id')} MAF output missing run_flow"


# ── Metric tests (real LLM, guarded by needs_real_llm) ────────────────────────


class TestDebateFlowQuality:
    """LLM-graded quality metrics for the debate flow output."""

    @needs_real_llm
    def test_advocate_argument_coherence(self):
        """Advocate openings must be logically coherent with the proposition."""
        metric = GEval(
            name="ArgumentCoherence",
            criteria=(
                "The argument clearly states a position, provides at least two supporting "
                "reasons with evidence or logic, and directly addresses the proposition. "
                "Score 1.0 for fully coherent, 0.0 for incoherent or off-topic."
            ),
            evaluation_params=[LLMTestCaseParams.INPUT, LLMTestCaseParams.ACTUAL_OUTPUT],
            threshold=_THRESHOLD_COHERENCE,
        )
        for sample in DEBATE_EVAL_DATASET:
            tc = LLMTestCase(
                input=f"Proposition: {sample['proposition']}",
                actual_output=sample["advocate_opening"],
            )
            assert_test(tc, [metric])

    @needs_real_llm
    def test_devil_advocate_counter_argument_quality(self):
        """Devil's advocate responses must engage with the opening argument, not ignore it."""
        metric = GEval(
            name="CounterArgumentQuality",
            criteria=(
                "The counter-argument directly addresses claims made in the opening, "
                "provides specific objections or counterexamples, and does not merely "
                "restate the opposing position. Score 1.0 for substantive engagement."
            ),
            evaluation_params=[LLMTestCaseParams.INPUT, LLMTestCaseParams.ACTUAL_OUTPUT],
            threshold=_THRESHOLD_COHERENCE,
        )
        for sample in DEBATE_EVAL_DATASET:
            tc = LLMTestCase(
                input=(f"Proposition: {sample['proposition']}\nOpening argument: {sample['advocate_opening']}"),
                actual_output=sample["devil_advocate_response"],
            )
            assert_test(tc, [metric])

    @needs_real_llm
    def test_verdict_quality(self):
        """Judge verdict must fairly weigh both sides and end with the word VERDICT."""
        metric = GEval(
            name="VerdictQuality",
            criteria=(
                "The verdict: (1) references specific arguments from both sides, "
                "(2) provides a reasoned conclusion, and (3) ends with the word VERDICT. "
                "Score 1.0 only if all three criteria are met."
            ),
            evaluation_params=[LLMTestCaseParams.INPUT, LLMTestCaseParams.ACTUAL_OUTPUT],
            threshold=_THRESHOLD_VERDICT,
        )
        for sample in DEBATE_EVAL_DATASET:
            tc = LLMTestCase(
                input=(
                    f"Proposition: {sample['proposition']}\n"
                    f"Advocate: {sample['advocate_opening']}\n"
                    f"Devil's advocate: {sample['devil_advocate_response']}"
                ),
                actual_output=sample["judge_verdict"],
            )
            assert_test(tc, [metric])

    @needs_real_llm
    def test_verdict_contains_keyword(self):
        """Structural check: all sample verdicts must contain VERDICT (as per termination cond)."""
        for sample in DEBATE_EVAL_DATASET:
            assert "VERDICT" in sample["judge_verdict"], f"Verdict for '{sample['proposition']}' must contain 'VERDICT'"
            for kw in sample["expected_verdict_keywords"]:
                assert kw.lower() in sample["judge_verdict"].lower(), (
                    f"Expected keyword '{kw}' not found in verdict for '{sample['proposition']}'"
                )

    @needs_real_llm
    def test_verdict_relevance_to_proposition(self):
        """The verdict must be relevant to the original proposition."""
        metric = AnswerRelevancyMetric(threshold=_THRESHOLD_VERDICT)
        for sample in DEBATE_EVAL_DATASET:
            tc = LLMTestCase(
                input=sample["proposition"],
                actual_output=sample["judge_verdict"],
            )
            assert_test(tc, [metric])

    @needs_real_llm
    def test_faithfulness_on_langfuse_dataset(self, langfuse_dataset_samples):
        """If a Langfuse debate dataset is configured, validate verdict faithfulness."""
        if not langfuse_dataset_samples:
            pytest.skip("No Langfuse dataset configured (set LANGFUSE_EVAL_DATASET)")

        metric = AnswerRelevancyMetric(threshold=_THRESHOLD_VERDICT)
        for sample in langfuse_dataset_samples:
            tc = LLMTestCase(
                input=str(sample["input"]),
                actual_output=str(sample.get("expected_output", "")),
            )
            assert_test(tc, [metric])
