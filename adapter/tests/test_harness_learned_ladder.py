"""
The learned recovery ranking and the opt-in failed-task retry (twin of packages/harness
src/nodes/rollback-replan-learned.test.ts).

* ``pick_learned_strategy``: the nth switch takes the nth-ranked strategy, stepping past the one in effect — the default
  next-after-current rule skips the learned winner whenever the current strategy sits above it.
* precedence (learned_ladder on, weights for the class): learned ranking > curated failure-mode match; a supervisor
  REDIRECT_STRATEGY still outranks both; flag off is the old behaviour.
* ``retry_failed_task``: every failed leaf is re-queued after the switch, not only when nothing else is pending.

Run: pytest adapter/tests/test_harness_learned_ladder.py -q --noconftest
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.experience_store import InMemoryExperienceStore, build_strategy_ordering
from harness.failure_modes import FailureDiagnostics, MatchResult
from harness.recovery import STRATEGY_ORDER, StrategyState
from harness.replanning import pick_learned_strategy, rollback_and_replan
from harness.task_graph import Task, TaskGraph
from harness.world_model import WorldModel

RANKING = ["BROADER_SEARCH", "TRACE_EXEC", "DIRECT_EDIT", "REIMPLEMENT", "MINIMAL_FIX", "ESCALATE"]


def _caller() -> SimpleNamespace:
    return SimpleNamespace(success_criteria=["done"], constraints_changed=False)


def _go(store, *, learned=False, retry=False, directive=None, matched=None, extra=()):
    t = Task(id="t1", description="a task", status="FAILED")
    fd = FailureDiagnostics()
    fd.matched_pattern = matched
    graph = TaskGraph(tasks=[t, *extra])
    return rollback_and_replan(
        t, StrategyState(), fd, graph, WorldModel(), _caller(), store, None, directive, False, learned, retry
    )


def _learned_store(failure_class: str = "") -> InMemoryExperienceStore:
    store = InMemoryExperienceStore()
    store.set_strategy_weight(f"BROADER_SEARCH:{failure_class}", 0.9)
    store.set_strategy_weight(f"TRACE_EXEC:{failure_class}", 0.7)
    store.set_strategy_weight(f"DIRECT_EDIT:{failure_class}", 0.5)
    return store


def test_pick_learned_strategy_takes_the_top_choice_first():
    assert pick_learned_strategy(RANKING, "DIRECT_EDIT", 0) == "BROADER_SEARCH"


def test_pick_learned_strategy_steps_past_the_current_and_walks_down():
    assert pick_learned_strategy(RANKING, "BROADER_SEARCH", 0) == "TRACE_EXEC"
    assert pick_learned_strategy(RANKING, "BROADER_SEARCH", 1) == "TRACE_EXEC"
    assert pick_learned_strategy(RANKING, "TRACE_EXEC", 2) == "DIRECT_EDIT"
    assert pick_learned_strategy(RANKING, "ESCALATE", 9) == "ESCALATE"


def test_premise_default_rule_skips_the_learned_winner():
    assert build_strategy_ordering("", _learned_store())[0] == "BROADER_SEARCH"
    r = _go(_learned_store(), learned=False)
    assert r.new_strategy_state.current_strategy == build_strategy_ordering("", _learned_store())[3]
    assert r.learned_switch is None


def test_flag_on_learned_ranking_is_tried_first_and_reported():
    r = _go(_learned_store(), learned=True)
    assert r.new_strategy_state.current_strategy == "BROADER_SEARCH"
    assert r.learned_switch == {"failure_class": "", "strategy": "BROADER_SEARCH"}


def test_flag_on_default_order_is_identical_to_flag_off():
    off = _go(InMemoryExperienceStore(), learned=False)
    on = _go(InMemoryExperienceStore(), learned=True)
    assert on.new_strategy_state.current_strategy == off.new_strategy_state.current_strategy == STRATEGY_ORDER[1]
    assert on.learned_switch is None


def _curated() -> MatchResult:
    return MatchResult(failure_class="timeout", confidence=0.9, matched_pattern="x", strategy_affinity="REIMPLEMENT")


def test_learned_ranking_outranks_curated_match():
    r = _go(_learned_store("timeout"), learned=True, matched=_curated())
    assert r.new_strategy_state.current_strategy == "BROADER_SEARCH"
    assert r.learned_switch == {"failure_class": "timeout", "strategy": "BROADER_SEARCH"}
    assert r.failure_mode_switch is None
    assert any(x.startswith("learned:timeout") for x in r.new_strategy_state.switch_triggers)


def test_flag_off_curated_match_still_wins():
    r = _go(_learned_store("timeout"), learned=False, matched=_curated())
    assert r.new_strategy_state.current_strategy == "REIMPLEMENT"
    assert r.failure_mode_switch is not None
    assert r.learned_switch is None


def test_no_weights_for_the_class_curated_match_still_wins():
    r = _go(InMemoryExperienceStore(), learned=True, matched=_curated())
    assert r.new_strategy_state.current_strategy == "REIMPLEMENT"
    assert r.learned_switch is None


def test_supervisor_redirect_outranks_the_learned_ranking():
    directive = SimpleNamespace(action="REDIRECT_STRATEGY", strategy_hint="MINIMAL_FIX", rationale="r", plan_note=None)
    r = _go(_learned_store("timeout"), learned=True, directive=directive, matched=_curated())
    assert r.new_strategy_state.current_strategy == "MINIMAL_FIX"
    assert r.learned_switch is None


def _status(result) -> str:
    return next(t.status for t in result.new_task_graph.tasks if t.id == "t1")


def test_retry_off_leaves_a_lone_failed_task_failed():
    assert _status(_go(None, retry=False)) == "FAILED"


def test_retry_on_requeues_it():
    assert _status(_go(None, retry=True)) == "PENDING"


def test_retry_on_also_when_other_tasks_are_pending():
    other = Task(id="t2", description="other", status="PENDING")
    assert _status(_go(None, retry=False, extra=[other])) == "FAILED"
    assert _status(_go(None, retry=True, extra=[other])) == "PENDING"


def test_retry_on_requeues_a_failed_task_that_has_a_dependent():
    def build(retry):
        t = Task(id="t1", description="a task", status="FAILED")
        dep = Task(id="t2", description="dependent", status="PENDING", depends_on=["t1"])
        fd = FailureDiagnostics()
        graph = TaskGraph(tasks=[t, dep])
        return rollback_and_replan(
            t, StrategyState(), fd, graph, WorldModel(), _caller(), None, None, None, False, False, retry
        )

    assert _status(build(False)) == "FAILED"
    assert _status(build(True)) == "PENDING"
