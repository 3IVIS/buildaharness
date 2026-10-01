"""
The semantic failure matcher classifies a task's FIRST failure (twin of packages/harness
src/harness-runtime-failure-match-first-failure.test.ts).

``failure_history`` is written by rollback_and_replan, which runs after the matcher block, so a guard on the history
alone meant a transient error on a single-task turn was only matched after the turn had been given up on.

Run: PYTHONPATH=adapter pytest adapter/tests/test_harness_failure_match_first_failure.py -q --noconftest
"""

from __future__ import annotations

from harness.failure_modes import MatchResult
from harness.runtime import HarnessRunOptions, HarnessRuntime
from harness.task_graph import Task

MATCH = MatchResult(
    failure_class="TOOL_UNAVAILABLE_CASCADE", confidence=0.9, matched_pattern="tool-unavailable-cascade"
)


def _run(fail_first: bool, matcher):
    calls = {"n": 0}
    switches: list[dict] = []

    def tool(_ctx=None):
        calls["n"] += 1
        if fail_first and calls["n"] == 1:
            raise RuntimeError("API Error: 503 service unavailable")
        return "The answer is 42."

    opts = HarnessRunOptions(
        max_steps=8,
        initial_tasks=[Task(id="t1", description="Answer the question", status="PENDING", risk_level="LOW")],
        tool_executors={"default": tool},
        semantic_failure_matcher=matcher,
        on_failure_mode_switch=switches.append,
    )
    result = HarnessRuntime().run("answer", ["answered"], opts)
    return calls["n"], switches, str(result.final_result)


def test_a_transient_error_is_classified_and_the_task_retried_to_success():
    seen: list[list[str]] = []

    def matcher(symptoms, _entries):
        seen.append(list(symptoms))
        return MATCH

    n, switches, reply = _run(True, matcher)
    assert seen[0] == ["SYSTEM_ERROR: API Error: 503 service unavailable"]
    assert [(s["failure_class"], s["strategy"]) for s in switches] == [("TOOL_UNAVAILABLE_CASCADE", "REIMPLEMENT")]
    assert n == 2
    assert reply == "The answer is 42."


def test_negative_control_no_matcher_the_single_failure_is_not_retried():
    n, switches, reply = _run(True, None)
    assert n == 1
    assert "couldn't complete this" in reply
    assert switches == []


def test_a_turn_with_no_failure_never_calls_the_matcher():
    called = {"n": 0}

    def matcher(_symptoms, _entries):
        called["n"] += 1
        return MATCH

    n, _switches, reply = _run(False, matcher)
    assert called["n"] == 0
    assert n == 1
    assert reply == "The answer is 42."


def _fail_root(matched: bool):
    from types import SimpleNamespace

    from harness.experience_store import InMemoryExperienceStore
    from harness.failure_modes import FailureDiagnostics
    from harness.recovery import StrategyState
    from harness.replanning import rollback_and_replan
    from harness.task_graph import TaskGraph
    from harness.world_model import WorldModel

    fd = FailureDiagnostics()
    if matched:
        fd.matched_pattern = MatchResult(
            failure_class="TOOL_UNAVAILABLE_CASCADE",
            confidence=0.9,
            matched_pattern="tool-unavailable-cascade",
            strategy_affinity="REIMPLEMENT",
        )
    tasks = [
        Task(id="1", description="task 1", status="FAILED"),
        Task(id="2", description="task 2", status="PENDING"),
        Task(id="3", description="task 3", status="PENDING", depends_on=["1", "2"]),
    ]
    caller = SimpleNamespace(success_criteria=["done"], constraints_changed=False)
    return rollback_and_replan(
        tasks[0],
        StrategyState(),
        fd,
        TaskGraph(tasks=tasks),
        WorldModel(),
        caller,
        InMemoryExperienceStore(),
        None,
        None,
        False,
        False,
        False,
    )


def test_a_confident_match_requeues_a_failed_root_that_has_dependents_and_a_pending_sibling():
    r = _fail_root(True)
    assert {t.id: t.status for t in r.new_task_graph.tasks}["1"] == "PENDING"
    assert any(trigger.startswith("failure_mode:requeue_task") for trigger in r.new_strategy_state.switch_triggers)


def test_negative_control_no_match_the_same_failed_root_stays_failed():
    r = _fail_root(False)
    assert {t.id: t.status for t in r.new_task_graph.tasks}["1"] == "FAILED"
