"""Behaviour ported from the TS harness (packages/harness) that the older Python tests did not cover:
experience learning + warm start, gates resolving in place, external updates (cancel / budget answers / add_*),
escalation response handling, rollback_and_replan, the belief graph shape and TS-shaped state JSON."""

from __future__ import annotations

import pytest

from harness.belief_graph import BeliefDepGraph, DepGraphBudget
from harness.caller_state import CallerState, inject_clarification, split_ws
from harness.constraint_propagation import cancel_task_graph
from harness.control_state import ControlState, resolve_control_state
from harness.diagnostics import Diagnostics
from harness.escalation import AskAnswer, escalate_budget_exhausted, handle_escalation_response
from harness.evidence import EvidenceStore, gather_evidence
from harness.experience_learning import (
    LEARNING_RATE,
    PRIOR,
    failure_class_of,
    journal_entry_for,
    learn_from_journal,
    recovery_attempts,
)
from harness.experience_store import InMemoryExperienceStore, UnavailableExperienceStore, warm_start_from_store
from harness.external_updates import PendingUpdate, UpdateChannel, check_external_updates
from harness.failure_modes import FailureDiagnostics, MatchResult
from harness.gates import StalenessError, action_gate
from harness.memory import MemoryState
from harness.output_contract import OutputContract
from harness.recovery import STRATEGY_ORDER, StrategyState
from harness.replanning import rollback_and_replan
from harness.supervisor import SupervisorDirective
from harness.task_graph import Task, TaskGraph
from harness.world_model import Belief, WorldModel


class _Channel(UpdateChannel):
    def __init__(self, update: PendingUpdate | None) -> None:
        self._update = update

    def poll(self) -> PendingUpdate | None:
        update, self._update = self._update, None
        return update


def _graph(*tasks: Task) -> TaskGraph:
    return TaskGraph(tasks=list(tasks))


# ── experience learning / stores ─────────────────────────────────────────────


def test_journal_entry_and_failure_class_round_trip():
    ok = journal_entry_for(1, "DIRECT_EDIT", True, output="x" * 700)
    assert (ok.outcome, ok.success, len(ok.verbatim)) == ("completed", True, 500)
    bad = journal_entry_for(2, "TRACE_EXEC", False, "tool_error", output="ignored")
    assert bad.outcome == "failed:tool_error" and bad.verbatim is None
    assert failure_class_of(bad) == "tool_error"
    assert failure_class_of(ok) is None


def test_recovery_attempts_pair_a_failure_with_the_strategy_tried_next():
    journal = [
        journal_entry_for(1, "DIRECT_EDIT", False, "tool_error"),
        journal_entry_for(2, "TRACE_EXEC", True),
        journal_entry_for(3, "not_a_strategy", False, "x"),
        journal_entry_for(4, "TRACE_EXEC", True),
    ]
    attempts = recovery_attempts(journal)
    assert [(a.strategy, a.failure_class, a.success) for a in attempts] == [
        ("TRACE_EXEC", "tool_error", True),
        ("TRACE_EXEC", "x", True),  # a failed entry of any kind is "answered" by a following strategy entry
    ]


def test_learn_from_journal_moves_weights_and_priors_by_the_learning_rate():
    store = InMemoryExperienceStore()
    journal = [journal_entry_for(1, "DIRECT_EDIT", False, "tool_error"), journal_entry_for(2, "TRACE_EXEC", True)]
    learn_from_journal(journal, store)

    weights = store.get_strategy_weights()
    assert set(weights) == {f"{s}:tool_error" for s in STRATEGY_ORDER}  # all seeded at PRIOR then one updated
    assert weights["TRACE_EXEC:tool_error"] == pytest.approx(PRIOR * (1 - LEARNING_RATE) + LEARNING_RATE)
    assert weights["DIRECT_EDIT:tool_error"] == PRIOR
    assert store.get_class_priors() == {"tool_error": pytest.approx(LEARNING_RATE)}

    learn_from_journal([journal_entry_for(1, "DIRECT_EDIT", True)], store)  # no failure seen -> the prior decays
    assert store.get_class_priors()["tool_error"] == pytest.approx(round(LEARNING_RATE * (1 - LEARNING_RATE), 4))

    unavailable = UnavailableExperienceStore()
    learn_from_journal(journal, unavailable)
    assert unavailable.get_strategy_weights() == {}
    assert unavailable.available is False


def test_in_memory_store_round_trips_and_ignores_newer_schema():
    store = InMemoryExperienceStore()
    store.set_strategy_weight("DIRECT_EDIT:x", 0.9)
    store.set_class_prior("x", 0.4)
    store.add_decomposition({"task_type": "t", "decomposition": ["a"], "success_rate": 1.0})
    restored = InMemoryExperienceStore.from_dict(store.to_dict())
    assert restored.get_strategy_weights() == {"DIRECT_EDIT:x": 0.9}
    assert restored.get_decompositions()[0]["task_type"] == "t"
    with pytest.warns(UserWarning):
        assert (
            InMemoryExperienceStore.from_dict(
                {"schemaVersion": 99, "strategy_weights": {"a": 1}}
            ).get_strategy_weights()
            == {}
        )


def test_warm_start_adds_weights_copies_priors_shrinks_decay_and_sets_the_ladder():
    store = InMemoryExperienceStore()
    store.set_strategy_weight("TRACE_EXEC:x", 10.0)
    store.set_strategy_weight("BROADER_SEARCH:y", 4.0)
    store.set_strategy_weight("NOT_A_STRATEGY:x", 99.0)
    store.set_class_prior("x", 0.6)
    ss = StrategyState()
    fd = FailureDiagnostics()
    budget = DepGraphBudget()

    warm_start_from_store(store, ss, fd, budget, TaskGraph())

    assert ss.prior_strategy_weights["TRACE_EXEC"] == pytest.approx(1 / 6 + 10)
    assert "NOT_A_STRATEGY" not in ss.prior_strategy_weights
    assert fd.failure_mode_library.class_priors == {"x": 0.6}
    # total weight 113 -> min(0.5, 1.13) = 0.5: decay 0.05 * 0.5 = 0.025
    assert budget.confidence_decay_rate == pytest.approx(0.025)
    assert ss.recovery_strategy_order[0] == "TRACE_EXEC"
    assert sorted(ss.recovery_strategy_order) == sorted(STRATEGY_ORDER)

    untouched = StrategyState()
    warm_start_from_store(UnavailableExperienceStore(), untouched, fd, budget)
    assert untouched == StrategyState()


# ── evidence ─────────────────────────────────────────────────────────────────


def test_gather_evidence_requires_an_available_tool_and_forces_system_errors_high():
    from harness.evidence import ToolAvailability

    store = EvidenceStore(tool_availability_manifest={"grep": ToolAvailability(True)})
    warnings: list[str] = []
    assert (
        gather_evidence(
            id="e",
            obs="o",
            source="missing",
            evidence_type="OBSERVATION",
            evidence_store=store,
            on_warning=warnings.append,
        )
        is None
    )
    assert warnings == ['gatherEvidence: tool "missing" unavailable; no evidence collected']

    default = gather_evidence(id="e1", obs="o", source="grep", evidence_type="OBSERVATION", evidence_store=store)
    error = gather_evidence(
        id="e2", obs="o", source="grep", evidence_type="SYSTEM_ERROR", evidence_store=store, reliability="LOW"
    )
    assert (default.reliability, error.reliability) == ("MEDIUM", "HIGH")
    assert [e.id for e in store.observations] == ["e1", "e2"]


# ── gates ────────────────────────────────────────────────────────────────────


def test_action_gate_resolves_a_stale_control_state_in_place():
    wm = WorldModel(generation_id=3)
    cs = ControlState(generation_id=1)
    result = action_gate(None, control_state=cs, world_model=wm, diagnostics=Diagnostics())
    assert result == "PASS"
    assert cs.generation_id == 3  # the caller's object was updated, not replaced

    with pytest.raises(StalenessError, match=r"ControlState generation_id \(1\) is stale relative to WorldModel \(3\)"):
        action_gate(None, control_state=ControlState(generation_id=1), world_model=wm)

    seen: list[int] = []

    def resolver(diagnostics, world_model, fd):
        seen.append(world_model.generation_id)
        return resolve_control_state(diagnostics, world_model, fd, step=world_model.generation_id)

    action_gate(
        None, control_state=ControlState(generation_id=0), world_model=wm, diagnostics=Diagnostics(), resolver=resolver
    )
    assert seen == [3]


# ── caller state / external updates ──────────────────────────────────────────


def test_split_ws_keeps_js_empty_tokens():
    assert split_ws(" a  b ") == ["", "a", "b", ""]
    assert " a b ".split() == ["a", "b"]  # what the old code produced


def test_inject_clarification_handles_add_constraint_and_add_success_criteria():
    cs = CallerState(current_constraints=["x"], success_criteria=["goal"])
    inject_clarification(cs, {"add_constraint": "y", "add_success_criteria": ["g2", "g3"]})
    assert cs.current_constraints == ["x", "y"]
    assert cs.success_criteria == ["goal", "g2", "g3"]
    assert cs.constraints_changed is True


def test_cancel_task_graph_blocks_unfinished_tasks_only():
    tg = _graph(
        Task(id="done", description="d", status="COMPLETE"),
        Task(id="bad", description="d", status="FAILED"),
        Task(id="run", description="d", status="RUNNING"),
        Task(id="again", description="d", status="BLOCKED", block_reason="goal_cancelled"),
    )
    cancel_task_graph(tg)
    assert [(t.status, t.block_reason) for t in tg.tasks] == [
        ("COMPLETE", None),
        ("FAILED", None),
        ("BLOCKED", "goal_cancelled"),
        ("BLOCKED", "goal_cancelled"),
    ]


def test_check_external_updates_cancel_current_cancels_the_graph():
    wm = WorldModel()
    tg = _graph(Task(id="t", description="d"))
    cs = CallerState()
    changed = check_external_updates(
        _Channel(PendingUpdate("constraint", {"cancel_current": True})), cs, wm, tg, Diagnostics()
    )
    assert changed is True
    assert tg.tasks[0].block_reason == "goal_cancelled"
    assert wm.generation_id == 1
    assert cs.constraints_changed is False


def _budget_answer(label: str) -> dict:
    return {"questionId": "budget-exhausted-resolution", "kind": "selected", "selectedLabels": [label]}


def test_budget_answers_are_control_actions_not_constraints():
    ms = MemoryState(max_steps=10)
    tg = _graph(Task(id="t", description="d"))
    cs = CallerState()
    update = PendingUpdate("clarification", {"clarification_answers": [_budget_answer("Continue with 10 more steps")]})
    assert check_external_updates(_Channel(update), cs, WorldModel(), tg, Diagnostics(), memory_state=ms) is False
    assert ms.max_steps == 20
    assert cs.current_constraints == []  # never reached the constraint pipeline

    stop = PendingUpdate(
        "clarification", {"clarification_answers": [_budget_answer("Stop and summarize progress so far")]}
    )
    check_external_updates(_Channel(stop), cs, WorldModel(), tg, Diagnostics(), memory_state=ms)
    assert tg.tasks[0].block_reason == "goal_cancelled"

    other = {"questionId": "other", "kind": "free_text", "freeText": "hello"}
    mixed = PendingUpdate(
        "clarification", {"clarification_answers": [_budget_answer("Let me clarify the goal"), other]}
    )
    cs2 = CallerState()
    check_external_updates(_Channel(mixed), cs2, WorldModel(), _graph(), Diagnostics(), memory_state=ms)
    assert ms.max_steps == 20  # "clarify" has no budget effect
    assert cs2.current_constraints == ["Free-text answer — other: hello"]


def test_handle_escalation_response_and_budget_helper(monkeypatch):
    monkeypatch.setenv("HARNESS_LEXICAL_ON", "criterion-scope")  # scope elimination is a lexical check (off by default)
    cs = CallerState(success_criteria=["ship it"])
    wm = WorldModel()
    tg = _graph(Task(id="t", description="unrelated words"))
    handle_escalation_response(cs, {"add_constraint": "be brief"}, wm, tg, OutputContract(), Diagnostics())
    assert cs.current_constraints == ["be brief"]
    assert cs.constraints_changed is False  # propagation ran and cleared the flag
    assert tg.tasks[0].block_reason == "scope_eliminated"
    assert any(t.description == "ship it" for t in tg.tasks)  # uncovered criterion added

    assert escalate_budget_exhausted(7, 5) == {
        "escalated": True,
        "reason": "budget_exhausted",
        "missing_info": ["Step count 7 reached max_steps limit of 5"],
    }
    assert AskAnswer.from_dict(_budget_answer("x")).question_id == "budget-exhausted-resolution"


# ── rollback_and_replan ──────────────────────────────────────────────────────


def _rollback(task, ss=None, fd=None, tg=None, wm=None, cs=None, store=None, directive=None, requeue=False):
    return rollback_and_replan(
        task,
        ss or StrategyState(),
        fd or FailureDiagnostics(),
        tg or _graph(task),
        wm or WorldModel(),
        cs or CallerState(success_criteria=["goal"]),
        store,
        None,
        directive,
        requeue,
    )


def test_rollback_records_the_failure_and_advances_the_ladder_locally():
    task = Task(id="t1", description="do it", status="RUNNING")
    fd = FailureDiagnostics()
    dep = Task(id="t2", description="after", status="RUNNING", depends_on=["t1"])
    result = _rollback(task, fd=fd, tg=_graph(task, dep))

    assert fd.failure_history[-1].failure_class == "unknown"
    assert fd.failure_history[-1].context == {"task_id": "t1"}
    assert result.replan_scope == "LOCAL" and result.cannot_progress is False
    assert result.new_strategy_state.current_strategy == "TRACE_EXEC"
    assert result.new_strategy_state.switch_count == 1
    assert result.new_strategy_state.switch_triggers == ["task_failed: t1"]
    assert dep.status == "PENDING"


def test_rollback_rebuilds_globally_on_a_stall_and_prefers_redirect_over_failure_mode_bias():
    task = Task(id="t1", description="do it", status="FAILED")
    stalled = StrategyState(completion_history=[0] * 5)
    fd = FailureDiagnostics(matched_pattern=MatchResult("SCOPE_CREEP", 0.9, "scope-creep", "MINIMAL_FIX"))
    wm = WorldModel()
    wm.beliefs.append(Belief(id="b", statement="s" * 200, confidence=0.9, derived_from=["o"]))
    directive = SupervisorDirective(action="REDIRECT_STRATEGY", rationale="pivot", strategy_hint="REIMPLEMENT")

    result = _rollback(task, ss=stalled, fd=fd, wm=wm, directive=directive)

    assert result.cannot_progress is True and result.replan_scope == "GLOBAL"
    assert result.new_strategy_state.current_strategy == "REIMPLEMENT"
    assert result.new_strategy_state.switch_triggers == ["supervisor:REDIRECT_STRATEGY pivot"]
    assert result.failure_mode_switch is None
    assert [t.description for t in result.new_task_graph.tasks] == ["goal", "Verify: " + "s" * 120]
    assert [t.abstraction_level for t in result.new_task_graph.tasks] == [1, 2]


def test_rollback_failure_mode_bias_reframe_and_requeue():
    task = Task(id="t1", description="do it", status="FAILED")
    biased = FailureDiagnostics(matched_pattern=MatchResult("SCOPE_CREEP", 0.7, "scope-creep", "MINIMAL_FIX"))
    result = _rollback(task, fd=biased)
    assert result.new_strategy_state.current_strategy == "MINIMAL_FIX"
    assert result.new_strategy_state.switch_triggers == [
        "failure_mode:SCOPE_CREEP -> MINIMAL_FIX",
        # a confident match re-queues the task that failed (not only a leaf), under its own trigger
        "failure_mode:requeue_task SCOPE_CREEP",
    ]
    assert result.failure_mode_switch == {"failure_class": "SCOPE_CREEP", "strategy": "MINIMAL_FIX"}
    assert result.new_task_graph.tasks[0].status == "PENDING"  # the confident match re-queued the failed task

    weak = FailureDiagnostics(matched_pattern=MatchResult("SCOPE_CREEP", 0.69, "scope-creep", "MINIMAL_FIX"))
    assert _rollback(task, fd=weak).new_strategy_state.current_strategy == "TRACE_EXEC"

    reframe = SupervisorDirective(action="REFRAME_PLAN", rationale="rethink", plan_note="split it")
    result = _rollback(task, directive=reframe)
    assert result.replan_scope == "GLOBAL"
    assert result.new_strategy_state.current_strategy == "DIRECT_EDIT"  # unchanged
    assert result.new_strategy_state.switch_count == 0
    assert [t.description for t in result.new_task_graph.tasks] == ["goal", "Reframe: split it"]


def test_rollback_uses_the_experience_ordering():
    store = InMemoryExperienceStore()
    store.set_strategy_weight("MINIMAL_FIX:unknown", 5.0)
    task = Task(id="t1", description="do it", status="FAILED")
    fd = FailureDiagnostics(matched_pattern=MatchResult("boom", 0.1, "x"))
    store.set_strategy_weight("MINIMAL_FIX:boom", 5.0)
    result = _rollback(task, fd=fd, store=store, ss=StrategyState(current_strategy="MINIMAL_FIX"))
    # ordering: MINIMAL_FIX first, so the next strategy after the current (MINIMAL_FIX) is the first default-order one
    assert result.new_strategy_state.current_strategy == "DIRECT_EDIT"


# ── belief graph / TS-shaped JSON ────────────────────────────────────────────


def test_belief_graph_json_uses_the_ts_shape_and_reads_the_legacy_one():
    graph = BeliefDepGraph()
    graph.add_edge("a", "b", 0.5, verified=True)
    graph.add_edge("b", "c", 0.5)
    graph.recompute_unverified_edge_ratio()
    d = graph.to_dict()
    assert d["derived_from_edges"][0] == {"from": "a", "to": "b", "confidence": 0.5, "verified": True}
    assert d["unverified_edge_ratio"] == 0.5
    assert BeliefDepGraph.from_dict(d).derived_from_edges[1].to_id == "c"

    legacy = BeliefDepGraph.from_dict(
        {
            "belief_nodes": {"a": "desc"},
            "edges": [{"from_id": "a", "to_id": "b", "confidence": 0.2}],
            "propagation_queue": ["a"],
        }
    )
    assert legacy.belief_nodes[0].belief_id == "a"
    assert legacy.propagation_queue[0].source_belief_id == "a"
    assert DepGraphBudget().confidence_decay_rate == 0.05


def test_state_json_round_trips_with_ts_shaped_fields():
    from harness.hypothesis import Hypothesis, HypothesisSet
    from harness.task_graph import Task

    hs = HypothesisSet(active=[Hypothesis(id="h", explanation="e", confidence=0.5, separating_check="check x")])
    hs.eliminate(Hypothesis(id="old", explanation="e", confidence=0.0))
    restored = HypothesisSet.from_dict(hs.to_dict())
    assert restored.active[0].separating_check == "check x"
    assert [h.id for h in restored.eliminated] == ["old"]
    assert restored.elimination_policy.floor == 0.05

    tg = TaskGraph(
        tasks=[Task(id="t", description="d", node_kind="goal_hypothesis", goal_id="g", hypothesis_ids=["h"])]
    )
    tg.set_conflict_probability("a", "b", 0.3)
    again = TaskGraph.from_dict(tg.to_dict())
    assert again.tasks[0].node_kind == "goal_hypothesis" and again.tasks[0].hypothesis_ids == ["h"]
    assert again.get_conflict_probability("b", "a") == 0.3

    ms = MemoryState()
    ms.journal.append(journal_entry_for(1, "DIRECT_EDIT", True))
    assert MemoryState.from_dict(ms.to_dict()).journal[0].outcome == "completed"
    assert (
        MemoryState.from_dict(
            {"token_budget": 5000, "journal": [{"event": "compression", "outcome": "pass"}]}
        ).token_budget.total
        == 5000
    )

    oc = OutputContract.from_dict({"format_requirements": {"format": "json"}})
    assert oc.format == "json"
    assert StrategyState.from_dict(StrategyState().to_dict()) == StrategyState()
