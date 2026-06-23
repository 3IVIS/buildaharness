"""
Shared fixtures for the buildaharness offline eval harness.

Design goals:
  - No running services required for basic eval runs.
  - Metric tests that require a real LLM are automatically skipped
    unless EVAL_USE_REAL_LLM=true is set.
  - Reference flows loaded from the checked-in flows/ directory so evals
    always test the same canonical specs that ship with the product.
  - Langfuse dataset export is optional: tests that need it are skipped
    when LANGFUSE_EVAL_DATASET is not set.

Environment variables:
  EVAL_USE_REAL_LLM      — set to "true" to call a real LLM via LiteLLM
  EVAL_MODEL             — model string for real-LLM runs (default: gpt-4o-mini)
  LANGFUSE_EVAL_DATASET  — name of a Langfuse dataset to pull live samples from
  OPENAI_API_KEY         — required when EVAL_USE_REAL_LLM=true
"""

import json
import os
from pathlib import Path

import pytest

# ── Paths ─────────────────────────────────────────────────────────────────────
# adapter/eval/conftest.py → parent.parent.parent = repo root (buildaharness/)
_REPO_ROOT = Path(__file__).parent.parent.parent
_FLOWS_DIR = _REPO_ROOT / "flows"


# ── Real-LLM guard ────────────────────────────────────────────────────────────


def needs_real_llm(func):
    """Decorator: skip a test unless EVAL_USE_REAL_LLM=true.

    Apply this to any test that calls a DeepEval or Ragas metric, because those
    metrics call a real LLM internally and cannot be meaningfully mocked.
    Structural / schema tests (no LLM involved) do NOT need this decorator.
    """
    return pytest.mark.skipif(
        os.getenv("EVAL_USE_REAL_LLM", "false").lower() != "true",
        reason="Set EVAL_USE_REAL_LLM=true to run LLM-dependent metric tests",
    )(func)


# ── Reference flow fixtures ───────────────────────────────────────────────────


@pytest.fixture(scope="session")
def rag_flow_spec() -> dict:
    """The canonical RAG agent flow spec (01-rag-agent-flow.json)."""
    return json.loads((_FLOWS_DIR / "01-rag-agent-flow.json").read_text())


@pytest.fixture(scope="session")
def moderation_flow_spec() -> dict:
    """The content moderation + HITL flow spec."""
    return json.loads((_FLOWS_DIR / "02-content-moderation-hitl-flow.json").read_text())


@pytest.fixture(scope="session")
def parallel_risk_spec() -> dict:
    return json.loads((_FLOWS_DIR / "03-parallel-risk-assessment-flow.json").read_text())


@pytest.fixture(scope="session")
def research_crew_spec() -> dict:
    return json.loads((_FLOWS_DIR / "04-research-crew-flow.json").read_text())


@pytest.fixture(scope="session")
def debate_flow_spec() -> dict:
    return json.loads((_FLOWS_DIR / "05-debate-agent-a2a-flow.json").read_text())


@pytest.fixture(scope="session")
def all_flow_specs(
    rag_flow_spec,
    moderation_flow_spec,
    parallel_risk_spec,
    research_crew_spec,
    debate_flow_spec,
) -> list[dict]:
    return [
        rag_flow_spec,
        moderation_flow_spec,
        parallel_risk_spec,
        research_crew_spec,
        debate_flow_spec,
    ]


# ── Synthetic eval dataset ────────────────────────────────────────────────────

RAG_EVAL_DATASET = [
    {
        "input": "What is LangGraph used for?",
        "context": (
            "LangGraph is a library for building stateful, multi-actor applications "
            "with LLMs. It extends LangChain with support for cyclic computation graphs, "
            "checkpointing, and human-in-the-loop control flows."
        ),
        "expected_output": (
            "LangGraph is used for building stateful multi-actor LLM applications "
            "with support for cyclic graphs, checkpointing, and human-in-the-loop flows."
        ),
    },
    {
        "input": "How does CrewAI handle memory?",
        "context": (
            "CrewAI supports short-term, long-term, entity, and contextual memory tiers. "
            "Short-term uses in-process storage. Long-term uses a vector store (ChromaDB "
            "by default). Entity memory extracts named entities and stores them separately. "
            "Contextual memory synthesises across all tiers."
        ),
        "expected_output": (
            "CrewAI supports four memory tiers: short-term (in-process), long-term "
            "(ChromaDB), entity (named entity extraction), and contextual (synthesis "
            "across tiers)."
        ),
    },
    {
        "input": "What is a hitl_breakpoint node?",
        "context": (
            "A hitl_breakpoint node pauses flow execution and presents a form to a "
            "human operator. The operator reviews the current state and provides "
            "structured feedback via resume_schema_fields. Execution resumes only "
            "after the operator submits the form."
        ),
        "expected_output": (
            "A hitl_breakpoint node pauses flow execution for human review. "
            "A human operator reviews the state, fills in resume_schema_fields, "
            "and resumes the flow."
        ),
    },
    {
        "input": "What runtimes does buildaharness support?",
        "context": (
            "buildaharness supports four runtimes: LangGraph (Python), CrewAI (Python), "
            "Mastra (TypeScript), and MS Agent Framework (Python, semantic-kernel v1.x). "
            "MAF shipped in Phase 4 and is the only runtime where agent_debate maps "
            "natively to AgentGroupChat. The canvas compiles flows to any of these via "
            "adapter codegen."
        ),
        "expected_output": (
            "buildaharness supports LangGraph, CrewAI, Mastra, and MS Agent Framework. "
            "The MAF adapter ships in Phase 4 with native support for agent_debate "
            "via AgentGroupChat."
        ),
    },
]


@pytest.fixture(scope="session")
def rag_eval_dataset() -> list[dict]:
    """Synthetic RAG eval samples — usable without a running Langfuse instance."""
    return RAG_EVAL_DATASET


# ── Langfuse dataset export (optional) ────────────────────────────────────────


@pytest.fixture(scope="session")
def langfuse_dataset_samples() -> list[dict]:
    """Pull samples from a named Langfuse dataset if LANGFUSE_EVAL_DATASET is set.

    Returns an empty list when the env var is absent, so tests that use this
    fixture skip gracefully in environments without Langfuse.
    """
    dataset_name = os.getenv("LANGFUSE_EVAL_DATASET", "")
    if not dataset_name:
        return []

    try:
        from langfuse import Langfuse

        lf = Langfuse()
        dataset = lf.get_dataset(dataset_name)
        return [
            {
                "input": item.input,
                "expected_output": item.expected_output,
                "metadata": item.metadata or {},
            }
            for item in dataset.items
        ]
    except Exception as exc:
        pytest.skip(f"Could not fetch Langfuse dataset '{dataset_name}': {exc}")
        return []
