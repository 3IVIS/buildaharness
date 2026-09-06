"""
S0 of plans/harness_trajectory_supervisor_plan.html — types + digest builder, inert.

Covers the plan's Testing-strategy Layer 1 (deterministic): serialization round-trip,
enum + payload safety, digest boundedness, digest coherence from each stall proxy,
and HarnessRunState checkpoint back-compat for the two new slots.

No behaviour change is exercised here — decide() and any loop wiring land in S1.
"""

from __future__ import annotations

import pytest

from harness.failure_modes import FailureDiagnostics, FailureEntry
from harness.recovery import STRATEGY_ORDER, StrategyState
from harness.state_store import HarnessRunState
from harness.supervisor import (
    SUPERVISOR_ACTIONS,
    InvestigationRequest,
    SupervisorDirective,
    UserQuestion,
    supervisor_enabled,
)
from harness.task_graph import Task, TaskGraph
from harness.trajectory_digest import TrajectoryDigest, build_digest
from harness.world_model import Contradiction, WorldModel

# ── Flag ─────────────────────────────────────────────────────────────────────


def test_flag_defaults_off(monkeypatch):
    monkeypatch.delenv("HARNESS_TRAJECTORY_SUPERVISOR", raising=False)
    assert supervisor_enabled() is False


@pytest.mark.parametrize("val", ["1", "true", "TRUE", "yes", "on", "enabled"])
def test_flag_truthy_values(monkeypatch, val):
    monkeypatch.setenv("HARNESS_TRAJECTORY_SUPERVISOR", val)
    assert supervisor_enabled() is True


@pytest.mark.parametrize("val", ["", "0", "false", "off", "nope"])
def test_flag_falsey_values(monkeypatch, val):
    monkeypatch.setenv("HARNESS_TRAJECTORY_SUPERVISOR", val)
    assert supervisor_enabled() is False


# ── SupervisorDirective round-trip ───────────────────────────────────────────


def _directives():
    return [
        SupervisorDirective.cont("nothing to do"),
        SupervisorDirective(action="REDIRECT_STRATEGY", rationale="pivot", strategy_hint="TRACE_EXEC"),
        SupervisorDirective(action="REFRAME_PLAN", rationale="wrong frame", plan_note="split the auth task"),
        SupervisorDirective(
            action="GATHER_EVIDENCE",
            rationale="need a fact",
            investigation=InvestigationRequest(question="which port?", suggested_tools=["read_file"], budget=3),
        ),
        SupervisorDirective(
            action="ASK_USER",
            rationale="ambiguous",
            question=UserQuestion(question="which env?", options=["staging", "prod"]),
        ),
        SupervisorDirective(action="ABORT", rationale="unrecoverable"),
    ]


@pytest.mark.parametrize("d", _directives())
def test_directive_round_trip_identity(d):
    assert SupervisorDirective.from_dict(d.to_dict()) == d


def test_directive_actions_enum_matches_literal():
    assert SUPERVISOR_ACTIONS == {
        "CONTINUE",
        "REDIRECT_STRATEGY",
        "REFRAME_PLAN",
        "GATHER_EVIDENCE",
        "ASK_USER",
        "ABORT",
    }


# ── Enum + payload safety (the plan's "enum safety" contract) ─────────────────


def test_unknown_action_degrades_to_continue():
    d = SupervisorDirective.from_dict({"action": "SELF_DESTRUCT", "rationale": "hi"})
    assert d.action == "CONTINUE"
    assert d.rationale == "hi"


def test_non_dict_degrades_to_continue():
    assert SupervisorDirective.from_dict(None).action == "CONTINUE"
    assert SupervisorDirective.from_dict("ABORT").action == "CONTINUE"
    assert SupervisorDirective.from_dict(["ABORT"]).action == "CONTINUE"


def test_redirect_without_hint_degrades():
    assert SupervisorDirective.from_dict({"action": "REDIRECT_STRATEGY"}).action == "CONTINUE"


def test_reframe_without_note_degrades():
    assert SupervisorDirective.from_dict({"action": "REFRAME_PLAN"}).action == "CONTINUE"


def test_gather_evidence_without_question_degrades():
    assert SupervisorDirective.from_dict({"action": "GATHER_EVIDENCE"}).action == "CONTINUE"
    assert (
        SupervisorDirective.from_dict({"action": "GATHER_EVIDENCE", "investigation": {"question": "  "}}).action
        == "CONTINUE"
    )


def test_ask_user_without_question_degrades():
    assert SupervisorDirective.from_dict({"action": "ASK_USER"}).action == "CONTINUE"
    assert SupervisorDirective.from_dict({"action": "ASK_USER", "question": {"options": ["a"]}}).action == "CONTINUE"


def test_payload_stripped_for_mismatched_action():
    # An ABORT that also carries an investigation payload must not retain it.
    d = SupervisorDirective.from_dict({"action": "ABORT", "rationale": "done", "investigation": {"question": "x"}})
    assert d.action == "ABORT"
    assert d.investigation is None
    assert d.question is None


def test_directive_rationale_is_length_capped():
    d = SupervisorDirective.from_dict({"action": "ABORT", "rationale": "x" * 5000})
    assert len(d.rationale) <= 600


# ── Payload dataclasses ──────────────────────────────────────────────────────


def test_investigation_round_trip_and_none():
    r = InvestigationRequest(question="q", suggested_tools=["read_file", "web_search"], budget=4)
    assert InvestigationRequest.from_dict(r.to_dict()) == r
    assert InvestigationRequest.from_dict(None) is None
    assert InvestigationRequest.from_dict("nope") is None


def test_investigation_budget_clamped():
    assert InvestigationRequest.from_dict({"question": "q", "budget": -5}).budget == 0
    assert InvestigationRequest.from_dict({"question": "q", "budget": 9999}).budget == 50
    assert InvestigationRequest.from_dict({"question": "q", "budget": "abc"}).budget == 5


def test_investigation_tool_list_capped():
    r = InvestigationRequest.from_dict({"question": "q", "suggested_tools": [f"t{i}" for i in range(50)]})
    assert len(r.suggested_tools) <= 8


def test_user_question_round_trip_and_none():
    q = UserQuestion(question="which?", options=["a", "b"])
    assert UserQuestion.from_dict(q.to_dict()) == q
    assert UserQuestion.from_dict(None) is None


# ── TrajectoryDigest ─────────────────────────────────────────────────────────


def test_digest_round_trip_identity():
    d = TrajectoryDigest(
        goal=["ship the feature"],
        steps_taken=7,
        stall_reason="strategy_loop",
        stall_history=["completion_velocity", "strategy_loop"],
        strategies_tried=[{"strategy": "DIRECT_EDIT", "outcome": "switched"}],
        failure_classes=[{"class": "compile_error", "count": 3}],
        reopened_tasks=["task-2: wire the resolver"],
        open_contradictions=["c1: belief A vs B"],
        blocking_unknowns=["which auth backend"],
        budget_remaining={"plan_revisions_used": 2},
    )
    assert TrajectoryDigest.from_dict(d.to_dict()) == d


def test_digest_from_dict_is_total_on_garbage():
    d = TrajectoryDigest.from_dict({"steps_taken": "not-an-int", "goal": None, "failure_classes": ["bad"]})
    assert d.steps_taken == 0
    assert d.goal == []
    assert d.failure_classes == []


# ── build_digest — boundedness (no dumps, everything capped) ──────────────────


def _oversized_state():
    ss = StrategyState(
        current_strategy="BROADER_SEARCH",
        switch_count=3,
        switch_triggers=[f"trigger-{i} " + "x" * 300 for i in range(20)],
        completion_history=[0] * 40,
        stall_reason="strategy_loop " + "y" * 500,
    )
    fd = FailureDiagnostics(failure_history=[FailureEntry(failure_class=f"class_{i % 5}", step=i) for i in range(60)])
    tg = TaskGraph(
        tasks=[
            Task(id=f"t{i}", description="d" * 400, status="FAILED", depends_on=[], risk_level="LOW") for i in range(30)
        ]
    )
    wm = WorldModel()
    wm.assumptions = [f"assumption {i} " + "z" * 400 for i in range(30)]
    for i in range(15):
        wm.contradictions.append(
            Contradiction(
                id=f"c{i}",
                type="pairwise",
                severity="HIGH",
                scope="local",
                involved_belief_ids=[f"b{i}a", f"b{i}b"],
                description="q" * 500,
            )
        )
    return ss, fd, tg, wm


def test_build_digest_is_bounded():
    ss, fd, tg, wm = _oversized_state()
    d = build_digest(ss, fd, tg, wm)
    dd = d.to_dict()

    # Every list field capped.
    assert len(dd["stall_history"]) <= 10
    assert len(dd["strategies_tried"]) <= 10
    assert len(dd["failure_classes"]) <= 10
    assert len(dd["reopened_tasks"]) <= 10
    assert len(dd["open_contradictions"]) <= 10
    assert len(dd["blocking_unknowns"]) <= 10

    # Every string field truncated.
    assert len(dd["stall_reason"]) <= 240
    for s in dd["stall_history"]:
        assert len(s) <= 80
    for c in dd["open_contradictions"]:
        assert len(c) <= 240
    for u in dd["blocking_unknowns"]:
        assert len(u) <= 240


def test_build_digest_contains_no_raw_state_objects():
    ss, fd, tg, wm = _oversized_state()
    d = build_digest(ss, fd, tg, wm)
    dd = d.to_dict()

    # Only json-primitive leaves — no nested dataclasses / big dicts leaked in.
    import json

    blob = json.dumps(dd)  # would raise on a non-serialisable object
    assert "failure_mode_library" not in blob
    assert "belief" not in blob or "beliefs" not in dd  # no world_model belief list
    assert isinstance(dd["budget_remaining"], dict)


# ── build_digest — coherent from each of the four stall proxies ───────────────


def test_digest_reflects_completion_velocity_stall():
    ss = StrategyState(stall_reason="completion_velocity", completion_history=[2, 2, 2, 2, 2], switch_count=1)
    d = build_digest(ss, FailureDiagnostics(), TaskGraph(), WorldModel())
    assert d.stall_reason == "completion_velocity"
    assert d.steps_taken == 5


def test_digest_reflects_strategy_loop_stall():
    ss = StrategyState(
        stall_reason="strategy_loop",
        switch_count=3,
        switch_triggers=["a", "b", "c"],
        current_strategy=STRATEGY_ORDER[3],
    )
    d = build_digest(ss, FailureDiagnostics(), TaskGraph(), WorldModel())
    assert d.stall_reason == "strategy_loop"
    assert [s["strategy"] for s in d.strategies_tried][:3] == STRATEGY_ORDER[:3]
    assert d.stall_history == ["a", "b", "c"]


def test_digest_reflects_failure_recurrence_stall():
    fd = FailureDiagnostics(failure_history=[FailureEntry(failure_class="flaky_test", step=i) for i in range(3)])
    ss = StrategyState(stall_reason="failure_recurrence")
    d = build_digest(ss, fd, TaskGraph(), WorldModel())
    assert d.stall_reason == "failure_recurrence"
    assert d.failure_classes == [{"class": "flaky_test", "count": 3}]


def test_digest_reflects_risk_oscillation_stall():
    ss = StrategyState(
        stall_reason="risk_oscillation",
        risk_state_history=["NORMAL", "CAUTIOUS", "NORMAL", "CAUTIOUS"],
    )
    d = build_digest(ss, FailureDiagnostics(), TaskGraph(), WorldModel())
    assert d.stall_reason == "risk_oscillation"


def test_digest_open_contradictions_high_only():
    wm = WorldModel()
    wm.contradictions.append(
        Contradiction(id="hi", type="pairwise", severity="HIGH", scope="local", description="real problem")
    )
    wm.contradictions.append(
        Contradiction(id="lo", type="pairwise", severity="LOW", scope="local", description="minor")
    )
    d = build_digest(StrategyState(), FailureDiagnostics(), TaskGraph(), wm)
    assert any("hi:" in c for c in d.open_contradictions)
    assert not any("lo:" in c for c in d.open_contradictions)


# ── HarnessRunState checkpoint back-compat ───────────────────────────────────


def test_pre_s0_checkpoint_loads_with_none_slots():
    # A dict written before S0 has neither key.
    old = HarnessRunState(run_id="r").to_dict()
    old.pop("pending_supervisor_directive", None)
    old.pop("pending_investigation", None)
    restored = HarnessRunState.from_dict("r", old)
    assert restored.pending_supervisor_directive is None
    assert restored.pending_investigation is None


def test_s0_checkpoint_round_trips_pending_directive():
    st = HarnessRunState(run_id="r")
    st.pending_supervisor_directive = SupervisorDirective(
        action="REDIRECT_STRATEGY", rationale="pivot", strategy_hint="TRACE_EXEC"
    )
    st.pending_investigation = InvestigationRequest(question="which port?", budget=2)
    restored = HarnessRunState.from_dict("r", st.to_dict())
    assert restored.pending_supervisor_directive == st.pending_supervisor_directive
    assert restored.pending_investigation == st.pending_investigation
