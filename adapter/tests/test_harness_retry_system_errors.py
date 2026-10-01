"""
retry_failed_system_errors: the failed task is re-queued after the ladder's switch only when the executor itself broke
(twin of the TS harness-runtime-retry-system-errors test).

Run: PYTHONPATH=adapter pytest adapter/tests/test_harness_retry_system_errors.py -q --noconftest
"""

from __future__ import annotations

from harness.runtime import HarnessRunOptions, HarnessRuntime
from harness.task_graph import Task

GAVE_UP = "couldn't complete this"


def _run(executor, *, system_errors=None, retry_failed_task=None):
    calls = {"n": 0}

    def tool(_ctx=None):
        calls["n"] += 1
        return executor(calls["n"])

    kwargs = {}
    if system_errors is not None:
        kwargs["retry_failed_system_errors"] = system_errors
    if retry_failed_task is not None:
        kwargs["retry_failed_task"] = retry_failed_task
    opts = HarnessRunOptions(
        max_steps=12,
        initial_tasks=[Task(id="t1", description="Answer the question", status="PENDING", risk_level="LOW")],
        tool_executors={"default": tool},
        **kwargs,
    )
    result = HarnessRuntime().run("answer", ["answered"], opts)
    return calls["n"], str(result.final_result)


def _throws_once(call):
    if call == 1:
        raise RuntimeError("API Error: 500 upstream hiccup")
    return "The answer is 42."


def _exhausts_once(call):
    if call == 1:
        return {
            "__harnessExecutionStatus": "failed",
            "__harnessFailureKind": "exhausted",
            "error": "Tool loop exceeded 5 iterations",
        }
    return "The answer is 42."


def _fails_without_kind_once(call):
    if call == 1:
        return {"__harnessExecutionStatus": "failed", "error": "tool returned an error"}
    return "The answer is 42."


def test_a_thrown_error_is_retried_once_and_the_turn_succeeds():
    calls, reply = _run(_throws_once, system_errors=True)
    assert calls == 2
    assert reply == "The answer is 42."


def test_a_failure_without_a_kind_counts_as_a_system_error():
    calls, reply = _run(_fails_without_kind_once, system_errors=True)
    assert calls == 2
    assert reply == "The answer is 42."


def test_negative_control_an_exhausted_budget_is_not_retried():
    calls, reply = _run(_exhausts_once, system_errors=True)
    assert calls == 1
    assert GAVE_UP in reply


def test_negative_control_option_off_a_thrown_error_is_not_retried():
    calls, reply = _run(_throws_once)
    assert calls == 1
    assert GAVE_UP in reply


def test_retry_failed_task_still_retries_everything():
    calls, reply = _run(_exhausts_once, retry_failed_task=True)
    assert calls == 2
    assert reply == "The answer is 42."


def _always_throws(_call):
    raise RuntimeError("API Error: 500 still broken")


def test_a_persistent_system_error_is_retried_exactly_once_then_gives_up_gracefully():
    calls, reply = _run(_always_throws, system_errors=True)
    assert calls == 2
    assert GAVE_UP in reply
