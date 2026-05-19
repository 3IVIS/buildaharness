"""
Eval suite — RAG flow quality metrics.

All metric tests require a real LLM and are skipped by default.
Set EVAL_USE_REAL_LLM=true (with OPENAI_API_KEY) to run them.

Metrics:
  AnswerRelevancyMetric    — does the answer address the question?
  FaithfulnessMetric       — is the answer grounded in the retrieved context?
  ContextualRecallMetric   — does the answer cover the expected output?

Thresholds (env-configurable):
  EVAL_THRESHOLD_RELEVANCY    default 0.7
  EVAL_THRESHOLD_FAITHFULNESS default 0.7
  EVAL_THRESHOLD_RECALL       default 0.6
"""

import os

import pytest

from eval.conftest import needs_real_llm

try:
    from deepeval import assert_test
    from deepeval.metrics import (
        AnswerRelevancyMetric,
        ContextualRecallMetric,
        FaithfulnessMetric,
    )
    from deepeval.test_case import LLMTestCase
    _DEEPEVAL_AVAILABLE = True
except ImportError:
    _DEEPEVAL_AVAILABLE = False

pytestmark = pytest.mark.skipif(
    not _DEEPEVAL_AVAILABLE,
    reason="deepeval not installed — run: pip install -r requirements-eval.txt",
)

_THRESHOLD_RELEVANCY    = float(os.getenv("EVAL_THRESHOLD_RELEVANCY",    "0.7"))
_THRESHOLD_FAITHFULNESS = float(os.getenv("EVAL_THRESHOLD_FAITHFULNESS", "0.7"))
_THRESHOLD_RECALL       = float(os.getenv("EVAL_THRESHOLD_RECALL",       "0.6"))


class TestRagFlowQuality:
    """Quality gate for the RAG agent reference flow."""

    @needs_real_llm
    def test_rag_answer_relevancy(self, rag_eval_dataset):
        metric = AnswerRelevancyMetric(threshold=_THRESHOLD_RELEVANCY)
        for sample in rag_eval_dataset:
            tc = LLMTestCase(
                input=sample["input"],
                actual_output=sample["expected_output"],
                retrieval_context=[sample["context"]],
            )
            assert_test(tc, [metric])

    @needs_real_llm
    def test_rag_faithfulness(self, rag_eval_dataset):
        metric = FaithfulnessMetric(threshold=_THRESHOLD_FAITHFULNESS)
        for sample in rag_eval_dataset:
            tc = LLMTestCase(
                input=sample["input"],
                actual_output=sample["expected_output"],
                retrieval_context=[sample["context"]],
            )
            assert_test(tc, [metric])

    @needs_real_llm
    def test_rag_contextual_recall(self, rag_eval_dataset):
        metric = ContextualRecallMetric(threshold=_THRESHOLD_RECALL)
        for sample in rag_eval_dataset:
            tc = LLMTestCase(
                input=sample["input"],
                actual_output=sample["expected_output"],
                retrieval_context=[sample["context"]],
                expected_output=sample["expected_output"],
            )
            assert_test(tc, [metric])

    @needs_real_llm
    def test_faithfulness_on_langfuse_dataset(self, langfuse_dataset_samples):
        """Run faithfulness against live Langfuse dataset samples if configured."""
        if not langfuse_dataset_samples:
            pytest.skip("No Langfuse dataset configured (set LANGFUSE_EVAL_DATASET)")

        metric = FaithfulnessMetric(threshold=_THRESHOLD_FAITHFULNESS)
        for sample in langfuse_dataset_samples:
            context = sample.get("metadata", {}).get("context", "")
            if not context:
                continue
            tc = LLMTestCase(
                input=str(sample["input"]),
                actual_output=str(sample.get("expected_output", "")),
                retrieval_context=[context],
            )
            assert_test(tc, [metric])
