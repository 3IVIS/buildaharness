"""
Tests for harness.semantic_checks — the LLM-backed semantic escalation layered on top of
run_one_iteration's lexical contradiction/failure-match baselines (Phase 5 of
plans/lexical_functions_hardening_plan.html).

Run with:
  pytest adapter/tests/test_semantic_checks.py -v --noconftest
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.failure_modes import FailurePattern  # noqa: E402
from harness.semantic_checks import semantic_contradiction_check, semantic_failure_match  # noqa: E402

_mock_litellm = MagicMock()
_mock_litellm.acompletion = AsyncMock()


@pytest.fixture(autouse=True)
def _reset_mock_litellm(monkeypatch):
    # semantic_checks.py does `import litellm as _litellm` lazily, inside each async function
    # call — so forcing sys.modules["litellm"] here (unconditional set, restored by monkeypatch's
    # own teardown) is what the function body actually sees, regardless of what any other test
    # file's own litellm mock (e.g. test_harness_primitives.py's, whose .acompletion isn't an
    # AsyncMock) already left in sys.modules at collection time. A plain
    # sys.modules.setdefault(...) at module scope — the pattern test_harness_primitives.py uses —
    # is a process-global "first file collected wins" race across test files in the same pytest
    # run, which is exactly what silently broke this file the first time it ran as part of the
    # full suite instead of in isolation: it inherited that other mock's plain (non-async)
    # MagicMock, `await`-ing it raised, and semantic_checks.py's own broad `except Exception`
    # swallowed the error into a false "no match" instead of surfacing it.
    monkeypatch.setitem(sys.modules, "litellm", _mock_litellm)
    _mock_litellm.acompletion.reset_mock()
    _mock_litellm.acompletion.side_effect = None
    yield


def _mock_llm_response(json_body: str):
    msg = MagicMock()
    msg.content = json_body
    choice = MagicMock()
    choice.message = msg
    resp = MagicMock()
    resp.choices = [choice]
    return resp


# ── semantic_contradiction_check ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_contradiction_returns_empty_without_calling_llm_when_no_new_beliefs():
    result = await semantic_contradiction_check([], [{"id": "b1", "statement": "x"}])
    assert result == []
    _mock_litellm.acompletion.assert_not_called()


@pytest.mark.asyncio
async def test_contradiction_calls_llm_and_returns_a_paraphrased_conflict():
    _mock_litellm.acompletion.return_value = _mock_llm_response(
        json.dumps({"contradictions": [{"belief_ids": ["b1", "b2"], "description": "conflicting home cities"}]})
    )
    result = await semantic_contradiction_check(
        [{"id": "b2", "statement": "je vis maintenant à Lyon"}],
        [{"id": "b1", "statement": "the user lives in Paris"}],
    )
    assert result == [{"belief_ids": ["b1", "b2"], "description": "conflicting home cities"}]
    assert _mock_litellm.acompletion.await_count == 1


@pytest.mark.asyncio
async def test_contradiction_returns_empty_when_model_finds_none():
    _mock_litellm.acompletion.return_value = _mock_llm_response(json.dumps({"contradictions": []}))
    result = await semantic_contradiction_check([{"id": "b1", "statement": "x"}], [])
    assert result == []


@pytest.mark.asyncio
async def test_contradiction_drops_a_malformed_entry_but_keeps_valid_ones():
    _mock_litellm.acompletion.return_value = _mock_llm_response(
        json.dumps(
            {
                "contradictions": [
                    {"belief_ids": ["b1"], "description": "valid one"},
                    {"belief_ids": "not-a-list", "description": "malformed"},
                    {"belief_ids": ["b2"], "description": ""},
                ]
            }
        )
    )
    result = await semantic_contradiction_check([{"id": "b1", "statement": "x"}], [])
    assert result == [{"belief_ids": ["b1"], "description": "valid one"}]


@pytest.mark.asyncio
async def test_contradiction_returns_empty_on_malformed_json_instead_of_raising():
    _mock_litellm.acompletion.return_value = _mock_llm_response("not json at all")
    result = await semantic_contradiction_check([{"id": "b1", "statement": "x"}], [])
    assert result == []


@pytest.mark.asyncio
async def test_contradiction_returns_empty_when_the_llm_call_itself_raises():
    _mock_litellm.acompletion.side_effect = RuntimeError("backend unreachable")
    result = await semantic_contradiction_check([{"id": "b1", "statement": "x"}], [])
    assert result == []


# ── semantic_failure_match ──────────────────────────────────────────────────────

_PATTERNS = [
    FailurePattern(
        name="TOOL_UNAVAILABLE_CASCADE",
        description="Multiple SYSTEM_ERROR evidences from different tools",
        required_conditions=["system_error", "unavailable", "tool"],
        excluded_conditions=[],
        strategy_affinity="REIMPLEMENT",
        hypothesis_template="x",
    )
]


@pytest.mark.asyncio
async def test_failure_match_returns_none_without_calling_llm_when_no_symptoms():
    result = await semantic_failure_match([], _PATTERNS)
    assert result is None
    _mock_litellm.acompletion.assert_not_called()


@pytest.mark.asyncio
async def test_failure_match_returns_none_without_calling_llm_when_no_patterns():
    result = await semantic_failure_match(["the request timed out"], [])
    assert result is None
    _mock_litellm.acompletion.assert_not_called()


@pytest.mark.asyncio
async def test_failure_match_calls_llm_and_returns_a_paraphrased_match():
    _mock_litellm.acompletion.return_value = _mock_llm_response(
        json.dumps({"matched": True, "pattern_name": "TOOL_UNAVAILABLE_CASCADE", "confidence": 0.8})
    )
    result = await semantic_failure_match(["several external services failed to respond"], _PATTERNS)
    assert result == {"pattern_name": "TOOL_UNAVAILABLE_CASCADE", "confidence": 0.8}


@pytest.mark.asyncio
async def test_failure_match_returns_none_when_model_reports_no_match():
    _mock_litellm.acompletion.return_value = _mock_llm_response(json.dumps({"matched": False}))
    result = await semantic_failure_match(["the weather is nice"], _PATTERNS)
    assert result is None


@pytest.mark.asyncio
async def test_failure_match_rejects_a_pattern_name_the_library_does_not_have():
    _mock_litellm.acompletion.return_value = _mock_llm_response(
        json.dumps({"matched": True, "pattern_name": "MADE_UP_PATTERN", "confidence": 0.9})
    )
    result = await semantic_failure_match(["something went wrong"], _PATTERNS)
    assert result is None


@pytest.mark.asyncio
async def test_failure_match_defaults_confidence_when_missing():
    _mock_litellm.acompletion.return_value = _mock_llm_response(
        json.dumps({"matched": True, "pattern_name": "TOOL_UNAVAILABLE_CASCADE"})
    )
    result = await semantic_failure_match(["tools kept failing"], _PATTERNS)
    assert result == {"pattern_name": "TOOL_UNAVAILABLE_CASCADE", "confidence": 0.5}


@pytest.mark.asyncio
async def test_failure_match_returns_none_on_malformed_json_instead_of_raising():
    _mock_litellm.acompletion.return_value = _mock_llm_response("not json at all")
    result = await semantic_failure_match(["something went wrong"], _PATTERNS)
    assert result is None


@pytest.mark.asyncio
async def test_failure_match_returns_none_when_the_llm_call_itself_raises():
    _mock_litellm.acompletion.side_effect = RuntimeError("backend unreachable")
    result = await semantic_failure_match(["something went wrong"], _PATTERNS)
    assert result is None
