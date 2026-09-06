"""
S3 of plans/harness_trajectory_supervisor_plan.html — the ASK_USER directive: a
structured question surfaced to the human at a stall edge, plus the resume path
that turns the answer into a user_clarification world-model Observation.

ASK_USER is wired in run_one_iteration()'s stall branch: within the per-run cap M
the loop escalates with a supervisor_question SurfaceBlocker carrying the question
+ options; the M+1th ASK_USER degrades to a plain cannot_make_progress escalation.
check_external_updates() records the clarification answer as an
Observation(source="user_clarification"). Flag-gated (HARNESS_TRAJECTORY_SUPERVISOR).

Run: pytest adapter/tests/test_harness_supervisor_s3.py -q --noconftest
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.diagnostics import (
    BeliefHealth,
    CoverageHealth,
    Diagnostics,
    ExecutionHealth,
    VerificationHealth,
)
from harness.external_updates import PendingUpdate, check_external_updates
from harness.failure_modes import FailureDiagnostics
from harness.hypothesis import HypothesisSet
from harness.loop import _SUPERVISOR_ASK_USER_CAP, run_one_iteration
from harness.memory import MemoryState
from harness.recovery import RecoveryBudget, StrategyState
from harness.state_store import HarnessRunState
from harness.supervisor import SupervisorDirective, UserQuestion
from harness.task_graph import Task, TaskGraph
from harness.world_model import Belief, Observation, WorldModel

STALL_HISTORY = [0, 0, 0, 0, 0, 0]


def _healthy_diagnostics() -> Diagnostics:
    return Diagnostics(
        belief_health=BeliefHealth(freshness=0.9, consistency=0.9, support=0.9),
        coverage_health=CoverageHealth(symptom_coverage=0.9, explanation_coverage=0.9),
        verification_health=VerificationHealth(strength=0.9, feasibility=0.9),
        execution_health=ExecutionHealth(progress_rate=0.9, failure_recurrence=0.1, oscillation_score=0.1),
    )


class _MockHarnessRunState:
    def __init__(self) -> None:
        self.escalation_pending = False
        self.pending_escalation = None
        self.pending_investigation = None
        self.pending_reviewer_verdict = None
        self.supervisor_ask_user_count = 0
        self.memory_state = MemoryState()
        self.memory_state.journal = []


def _ask(question="which environment?", options=("staging", "production")) -> SupervisorDirective:
    return SupervisorDirective(
        action="ASK_USER",
        rationale="ambiguous target — need a human decision",
        question=UserQuestion(question=question, options=list(options)),
    )


def _run(
    directive,
    *,
    stalled=True,
    recovery_budget=None,
    harness_run_state=None,
    strategy_state=None,
    monkeypatch=None,
):
    if monkeypatch is not None:
        monkeypatch.setenv("HARNESS_TRAJECTORY_SUPERVISOR", "1")
    wm = WorldModel()
    wm.add_observation(Observation(id="o0", content="obs", source="test"))
    wm.add_belief(Belief(id="b0", statement="belief 0", confidence=0.8, derived_from=["o0"]))
    ss = strategy_state or StrategyState(completion_history=list(STALL_HISTORY) if stalled else [1, 2, 3])
    tg = TaskGraph(tasks=[Task(id="t1", description="primary widget", status="ACTIVE", abstraction_level=0)])
    result = run_one_iteration(
        world_model=wm,
        diagnostics=_healthy_diagnostics(),
        hypothesis_set=HypothesisSet(active=[], eliminated=[]),
        task_graph=tg,
        failure_diagnostics=FailureDiagnostics(),
        memory_state=MemoryState(),
        strategy_state=ss,
        recovery_budget=recovery_budget,
        harness_run_state=harness_run_state,
        run_id="run-s3",
        step_count=0,
        supervisor_directive=directive,
    )
    return result, result.get("strategy_state", ss), wm


# ── ASK_USER → structured escalation ──────────────────────────────────────────


def test_ask_user_escalates_with_structured_question(monkeypatch):
    r, ss, _wm = _run(_ask(), monkeypatch=monkeypatch)
    assert r.get("escalated") is True
    esc = r["escalation"]
    assert esc["reason"] == "supervisor_question"
    assert esc["question"] == "which environment?"
    assert esc["options"] == ["staging", "production"]
    # ASK_USER does not run the deterministic ladder this iteration.
    assert ss.current_strategy == "DIRECT_EDIT"
    assert ss.switch_count == 0


def test_ask_user_escalates_via_escalate_when_run_state_present(monkeypatch):
    state = _MockHarnessRunState()
    r, _ss, _wm = _run(_ask(), harness_run_state=state, monkeypatch=monkeypatch)
    assert r.get("escalated") is True
    assert state.escalation_pending is True
    assert state.pending_escalation is not None
    assert state.pending_escalation.reason == "supervisor_question"
    assert state.pending_escalation.question == "which environment?"
    assert state.supervisor_ask_user_count == 1


def test_ask_user_records_switch_trigger(monkeypatch):
    _r, ss, _wm = _run(_ask(), monkeypatch=monkeypatch)
    assert any("supervisor:ASK_USER" in t for t in ss.switch_triggers)


def test_ask_user_consumes_recovery_budget(monkeypatch):
    budget = RecoveryBudget(max_plan_revisions=3, plan_revisions_used=0)
    r, _ss, _wm = _run(_ask(), recovery_budget=budget, monkeypatch=monkeypatch)
    assert r["recovery_budget"].plan_revisions_used == 1


def test_ask_user_options_omitted_when_empty(monkeypatch):
    r, _ss, _wm = _run(_ask(options=[]), monkeypatch=monkeypatch)
    esc = r["escalation"]
    assert esc["reason"] == "supervisor_question"
    assert "options" not in esc  # None → key omitted, byte-identical contract


# ── Per-run cap M ────────────────────────────────────────────────────────────


def test_ask_user_degrades_to_plain_escalation_past_cap(monkeypatch):
    state = _MockHarnessRunState()
    state.supervisor_ask_user_count = _SUPERVISOR_ASK_USER_CAP  # already at the cap
    r, ss, _wm = _run(_ask(), harness_run_state=state, monkeypatch=monkeypatch)
    assert r.get("escalated") is True
    esc = r["escalation"]
    assert esc["reason"] == "cannot_make_progress"
    assert "question" not in esc
    assert "options" not in esc
    assert state.supervisor_ask_user_count == _SUPERVISOR_ASK_USER_CAP  # not incremented past the cap
    assert any("ASK_USER->escalate(cap)" in t for t in ss.switch_triggers)


def test_ask_user_within_cap_increments_each_time(monkeypatch):
    state = _MockHarnessRunState()
    for expected in (1, 2):
        _run(_ask(), harness_run_state=state, monkeypatch=monkeypatch)
        assert state.supervisor_ask_user_count == expected


# ── Flag / stall gating ─────────────────────────────────────────────────────


def test_ask_user_flag_off_is_inert(monkeypatch):
    monkeypatch.delenv("HARNESS_TRAJECTORY_SUPERVISOR", raising=False)
    r, ss, _wm = _run(_ask(), monkeypatch=None)
    assert r.get("escalated") is not True
    assert ss.current_strategy == "TRACE_EXEC"  # falls through to the unchanged ladder


def test_ask_user_ignored_when_not_stalled(monkeypatch):
    ss = StrategyState(completion_history=[1, 2, 3])
    r, out_ss, _wm = _run(_ask(), stalled=False, strategy_state=ss, monkeypatch=monkeypatch)
    assert r.get("escalated") is not True
    assert not any("supervisor" in t for t in out_ss.switch_triggers)


def test_ask_user_without_question_coerces_to_ladder(monkeypatch):
    # A directly-constructed ASK_USER with no question payload must not escalate —
    # it falls through to the deterministic switch_strategy path.
    d = SupervisorDirective(action="ASK_USER", rationale="malformed", question=None)
    r, ss, _wm = _run(d, monkeypatch=monkeypatch)
    assert r.get("escalated") is not True
    assert ss.current_strategy == "TRACE_EXEC"


def test_ask_user_blocker_carries_no_raw_dumps(monkeypatch):
    r, _ss, _wm = _run(_ask(), monkeypatch=monkeypatch)
    esc = r["escalation"]
    assert set(esc.keys()) <= {"reason", "missing_info", "current_task_summary", "escalated_at", "question", "options"}
    blob = repr(esc)
    for leaked in ("beliefs", "hypothesis_set", "evidence_store", "generation_id", "derived_from"):
        assert leaked not in blob


# ── HarnessRunState serialisation of the counter ────────────────────────────


def test_supervisor_ask_user_count_round_trips():
    state = HarnessRunState(run_id="r1")
    state.supervisor_ask_user_count = 2
    restored = HarnessRunState.from_dict("r1", state.to_dict())
    assert restored.supervisor_ask_user_count == 2


def test_supervisor_ask_user_count_defaults_to_zero_on_legacy_state():
    d = HarnessRunState(run_id="r1").to_dict()
    d.pop("supervisor_ask_user_count", None)  # a pre-S3 checkpoint
    assert HarnessRunState.from_dict("r1", d).supervisor_ask_user_count == 0


# ── Resume path: clarification answer → user_clarification Observation ──────


class _OneShotChannel:
    def __init__(self, payload):
        self._payload = payload
        self._done = False

    def poll(self):
        if self._done:
            return None
        self._done = True
        return PendingUpdate(update_type="clarification", payload=self._payload)


def _apply_clarification(payload):
    from harness.caller_state import CallerState

    wm = WorldModel()
    cs = CallerState()
    tg = TaskGraph(tasks=[])
    processed = check_external_updates(_OneShotChannel(payload), cs, wm, tg, _healthy_diagnostics())
    return processed, wm, cs


def test_clarification_answer_becomes_user_clarification_observation():
    processed, wm, cs = _apply_clarification({"answer": "use staging"})
    assert processed is True
    clar = [o for o in wm.observations if o.source == "user_clarification"]
    assert len(clar) == 1
    assert "use staging" in clar[0].content
    # provenance also recorded in clarification_history (INV-01 is belief-level)
    assert cs.clarification_history and cs.clarification_history[-1]["answer"] == "use staging"


def test_clarification_empty_answer_records_no_observation_and_never_crashes():
    for payload in ({"answer": ""}, {"answer": "   "}, {}):
        processed, wm, _cs = _apply_clarification(payload)
        assert processed is True  # inject_clarification still ran
        assert [o for o in wm.observations if o.source == "user_clarification"] == []


def test_clarification_overlong_answer_is_clipped():
    processed, wm, _cs = _apply_clarification({"answer": "x" * 5000})
    assert processed is True
    clar = [o for o in wm.observations if o.source == "user_clarification"]
    assert len(clar) == 1
    assert len(clar[0].content) <= 640  # "User clarification: " prefix + 600-char clip


def test_clarification_value_not_in_options_is_accepted_as_freeform():
    # options are a hint, not a constraint — an answer outside them is still recorded.
    processed, wm, _cs = _apply_clarification({"answer": "something else entirely", "options": ["a", "b"]})
    assert processed is True
    clar = [o for o in wm.observations if o.source == "user_clarification"]
    assert len(clar) == 1
    assert "something else entirely" in clar[0].content
