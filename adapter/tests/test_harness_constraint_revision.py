"""
on_constraint_revision: a violation found at the END of a run sends the last answer back to the proposer once; only a
second violation fails the run (twin of packages/harness src/harness-runtime-constraint-revision.test.ts).

Run: PYTHONPATH=adapter pytest adapter/tests/test_harness_constraint_revision.py -q --noconftest
"""

from __future__ import annotations

import pytest

from harness.output_contract import OutputContractError
from harness.runtime import HarnessRunOptions, HarnessRuntime
from harness.task_graph import Task

BAD = "Indent with a tab."
GOOD = "Indent with two spaces."


def _judge(inp):
    if inp["reply"] == BAD:
        return {"violated": [{"constraint": "Do not use tabs", "reason": "indents with a tab"}]}
    return {"violated": []}


def _run(replies, *, revise, throwing_handler=False):
    calls = {"n": 0}
    events: list[dict] = []

    def tool(_ctx=None):
        reply = replies[min(calls["n"], len(replies) - 1)]
        calls["n"] += 1
        return reply

    def handler(event):
        events.append(event)
        if throwing_handler:
            raise RuntimeError("boom")

    opts = HarnessRunOptions(
        max_steps=8,
        initial_tasks=[Task(id="t1", description="Write the indentation guide", status="PENDING", risk_level="LOW")],
        caller_constraints=["Do not use tabs"],
        tool_executors={"default": tool},
        semantic_constraint_judge=_judge,
        on_constraint_revision=handler if revise else None,
    )
    result = HarnessRuntime().run("write the guide", ["guide written"], opts)
    return result, calls["n"], events


def test_a_violation_reopens_the_task_once_and_the_second_answer_is_the_result():
    result, calls, events = _run([BAD, GOOD], revise=True)
    assert result.final_result == GOOD
    assert calls == 2
    assert len(events) == 1
    assert events[0]["task_id"] == "t1"
    assert "Do not use tabs" in events[0]["note"]
    assert "indents with a tab" in events[0]["note"]


def test_negative_control_no_handler_the_same_violation_fails_the_run():
    with pytest.raises(OutputContractError):
        _run([BAD, GOOD], revise=False)


def test_a_second_violation_returns_the_answer_with_the_violation_attached_and_one_revision_is_attempted():
    result, calls, events = _run([BAD, BAD, BAD], revise=True)
    assert result.final_result == BAD
    assert result.unresolved_constraint_violations == [
        {"constraint": "Do not use tabs", "reason": "indents with a tab"}
    ]
    assert calls == 2
    assert len(events) == 1


def test_a_clean_answer_has_no_unresolved_violations():
    result, _calls, _events = _run([BAD, GOOD], revise=True)
    assert result.unresolved_constraint_violations is None


def test_a_clean_first_answer_never_fires_the_handler():
    result, calls, events = _run([GOOD, BAD], revise=True)
    assert result.final_result == GOOD
    assert calls == 1
    assert events == []


def test_a_throwing_handler_never_breaks_the_run():
    result, calls, _events = _run([BAD, GOOD], revise=True, throwing_handler=True)
    assert result.final_result == GOOD
    assert calls == 2
