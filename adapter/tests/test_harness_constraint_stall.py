"""
A run that stalls on a failed task ends with the harness's own could-not-complete reply; the constraint judge must not
judge that notice against the user's constraints (twin of the TS harness-runtime-constraint-stall test).

Run: PYTHONPATH=adapter pytest adapter/tests/test_harness_constraint_stall.py -q --noconftest
"""

from __future__ import annotations

import pytest

from harness.output_contract import OutputContractError
from harness.runtime import HarnessRunOptions, HarnessRuntime
from harness.task_graph import Task


def _run(*, failing):
    judged: list[str] = []

    def judge(inp):
        judged.append(inp["reply"])
        return {"violated": [{"constraint": "Write two sentences", "reason": "not an announcement"}]}

    def tool(_ctx=None):
        if failing:
            raise RuntimeError("model call failed")
        return "One sentence here."

    opts = HarnessRunOptions(
        max_steps=12,
        initial_tasks=[Task(id="t1", description="Write the announcement", status="PENDING", risk_level="LOW")],
        caller_constraints=["Write two sentences"],
        tool_executors={"default": tool},
        semantic_constraint_judge=judge,
    )
    return HarnessRuntime().run("write the announcement", ["announcement written"], opts), judged


def test_stalled_run_returns_its_reply_and_the_judge_never_sees_it():
    result, judged = _run(failing=True)
    assert "complete" in str(result.final_result).lower()
    assert judged == []


def test_negative_control_a_real_answer_is_still_judged():
    with pytest.raises(OutputContractError):
        _run(failing=False)


def _run_lexical(*, failing, monkeypatch):
    monkeypatch.setenv("HARNESS_LEXICAL_ON", "constraint-negation")

    def tool(_ctx=None):
        if failing:
            raise RuntimeError("model call failed")
        return "I will write the announcement tomorrow."

    opts = HarnessRunOptions(
        max_steps=12,
        initial_tasks=[Task(id="t1", description="Write the announcement", status="PENDING", risk_level="LOW")],
        caller_constraints=["Never write the announcement"],
        tool_executors={"default": tool},
    )
    return HarnessRuntime().run("write the announcement", ["announcement written"], opts)


def test_lexical_match_opt_in_does_not_fire_on_the_stalled_reply(monkeypatch):
    result = _run_lexical(failing=True, monkeypatch=monkeypatch)
    assert "complete" in str(result.final_result).lower()


def test_lexical_match_negative_control_still_fails_a_real_answer(monkeypatch):
    with pytest.raises(OutputContractError):
        _run_lexical(failing=False, monkeypatch=monkeypatch)
