"""
Eval suite — spec validation gate.

These tests are cheap (no LLM calls) and must pass before any metric
tests run.  They verify that all five reference flows:

  1. Parse against the Zod/JSON schema without errors.
  2. Compile to LangGraph Python without syntax errors.
  3. Compile to CrewAI Python without syntax errors.
  4. Compile to Mastra TypeScript without syntax errors.
  5. Compile to MS Agent Framework Python without syntax errors (Phase 4).

Run with: pytest eval/test_spec_validation.py --pythonpath adapter
"""

import ast

from crewai_adapter import compile_crewai
from langgraph_adapter import compile_langgraph
from maf_adapter import compile_maf
from mastra_adapter import compile_mastra
from validate import validate_spec


class TestSpecValidation:
    """All five reference flows must validate and compile without errors."""

    def test_rag_flow_validates(self, rag_flow_spec):
        validate_spec(rag_flow_spec)  # raises HTTPException on failure

    def test_moderation_flow_validates(self, moderation_flow_spec):
        validate_spec(moderation_flow_spec)

    def test_parallel_risk_validates(self, parallel_risk_spec):
        validate_spec(parallel_risk_spec)

    def test_research_crew_validates(self, research_crew_spec):
        validate_spec(research_crew_spec)

    def test_debate_flow_validates(self, debate_flow_spec):
        validate_spec(debate_flow_spec)

    def test_all_flows_compile_langgraph(self, all_flow_specs):
        for spec in all_flow_specs:
            code, _warnings = compile_langgraph(spec)
            # Generated Python must be syntactically valid.
            ast.parse(code)

    def test_all_flows_compile_crewai(self, all_flow_specs):
        for spec in all_flow_specs:
            code, _warnings = compile_crewai(spec)
            ast.parse(code)

    def test_all_flows_compile_mastra(self, all_flow_specs):
        for spec in all_flow_specs:
            code, _warnings = compile_mastra(spec)
            # TypeScript syntax check: verify the output is non-empty and
            # contains expected structural markers.
            assert "createStep" in code or "workflow" in code or "import" in code, (
                f"Mastra output for {spec.get('id')} looks empty: {code[:200]}"
            )

    def test_all_flows_compile_maf(self, all_flow_specs):
        """Phase 4: all 5 flows must compile to MS Agent Framework Python."""
        for spec in all_flow_specs:
            code, _warnings = compile_maf(spec)
            # Generated Python must be syntactically valid.
            ast.parse(code)
            # Must export the flow runner.
            assert "run_flow" in code, f"MAF output for {spec.get('id')} missing run_flow()"
            assert "_run_flow_async" in code, f"MAF output for {spec.get('id')} missing _run_flow_async()"
