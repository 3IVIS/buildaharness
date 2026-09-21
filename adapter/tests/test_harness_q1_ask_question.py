"""
Q1 of the internal plan — the ask-question primitive's
own module (adapter/harness/ask_question.py): independent of the Trajectory
Supervisor, three-channel mode resolution (INV-29), and the supervisor's S3
ASK_USER site refactored to call it as one caller among several.

Run: pytest adapter/tests/test_harness_q1_ask_question.py -v --noconftest
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.ask_question import (
    DEFAULT_ASK_MODE,
    ask_mode_globally_enabled,
    ask_question,
    build_ask_blocker,
    resolve_ask_mode,
)
from harness.diagnostics import (
    BeliefHealth,
    CoverageHealth,
    Diagnostics,
    ExecutionHealth,
    VerificationHealth,
)
from harness.escalation import AskQuestion, AskQuestionOption, EscalationHalt
from harness.hypothesis import HypothesisSet
from harness.loop import run_one_iteration
from harness.memory import MemoryState
from harness.recovery import StrategyState
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
        self.supervisor_ask_user_count = 0
        self.memory_state = MemoryState()
        self.memory_state.journal = []


def _q(question="which environment?", options=("staging", "production")) -> list[AskQuestion]:
    return [
        AskQuestion(
            id="q1",
            question=question,
            options=[AskQuestionOption(label=o) for o in options] if options else None,
        )
    ]


# ── DEFAULT_ASK_MODE ─────────────────────────────────────────────────────────


def test_default_ask_mode_is_disabled():
    assert DEFAULT_ASK_MODE == "disabled"


def test_ask_mode_globally_enabled_reads_env(monkeypatch):
    monkeypatch.delenv("HARNESS_ASK_QUESTION", raising=False)
    assert ask_mode_globally_enabled() is False
    monkeypatch.setenv("HARNESS_ASK_QUESTION", "1")
    assert ask_mode_globally_enabled() is True
    monkeypatch.setenv("HARNESS_ASK_QUESTION", "enabled")
    assert ask_mode_globally_enabled() is True
    monkeypatch.setenv("HARNESS_ASK_QUESTION", "nope")
    assert ask_mode_globally_enabled() is False


# ── INV-29: table-driven, most-restrictive-of-three ─────────────────────────


@pytest.mark.parametrize(
    "global_on,session_ask_mode,structured,expected",
    [
        (False, None, True, False),
        (False, True, True, False),  # a narrower scope's ON can't override a global OFF
        (False, False, True, False),
        (True, None, True, True),
        (True, True, True, True),
        (True, False, True, False),  # session forces off despite global on
        (True, None, False, False),  # call-site forces off despite global on
        (True, True, False, False),  # call-site off wins even with session on
        (False, False, False, False),
    ],
)
def test_resolve_ask_mode_inv29_table(monkeypatch, global_on, session_ask_mode, structured, expected):
    monkeypatch.setenv("HARNESS_ASK_QUESTION", "1" if global_on else "0")
    assert resolve_ask_mode(session_ask_mode=session_ask_mode, structured=structured) is expected


# ── build_ask_blocker: degrade vs. batch ────────────────────────────────────


def test_build_ask_blocker_disabled_collapses_to_legacy_shape(monkeypatch):
    monkeypatch.delenv("HARNESS_ASK_QUESTION", raising=False)
    blocker = build_ask_blocker(
        _q(),
        reason="supervisor_question",
        missing_info=["m"],
        current_task_summary="t",
    )
    assert blocker.question == "which environment?"
    assert blocker.options == ["staging", "production"]
    assert blocker.questions is None
    d = blocker.to_dict()
    assert "questions" not in d
    assert d["question"] == "which environment?"


def test_build_ask_blocker_enabled_populates_batch(monkeypatch):
    monkeypatch.setenv("HARNESS_ASK_QUESTION", "1")
    blocker = build_ask_blocker(
        _q(),
        reason="supervisor_question",
        missing_info=["m"],
        current_task_summary="t",
    )
    assert blocker.questions is not None
    assert len(blocker.questions) == 1
    assert blocker.question is None
    assert blocker.options is None
    d = blocker.to_dict()
    assert "question" not in d
    assert "options" not in d
    assert d["questions"][0]["id"] == "q1"


def test_build_ask_blocker_call_site_opt_out_wins_over_global_on(monkeypatch):
    monkeypatch.setenv("HARNESS_ASK_QUESTION", "1")
    blocker = build_ask_blocker(
        _q(),
        reason="supervisor_question",
        missing_info=["m"],
        current_task_summary="t",
        structured=False,
    )
    assert blocker.questions is None
    assert blocker.question == "which environment?"


def test_build_ask_blocker_no_questions_is_plain_missing_info_halt(monkeypatch):
    monkeypatch.setenv("HARNESS_ASK_QUESTION", "1")
    blocker = build_ask_blocker(
        [],
        reason="cannot_make_progress",
        missing_info=["clarification"],
        current_task_summary="t",
    )
    assert blocker.questions is None
    assert blocker.question is None
    assert blocker.options is None
    assert blocker.missing_info == ["clarification"]


def test_build_ask_blocker_options_omitted_when_absent(monkeypatch):
    monkeypatch.delenv("HARNESS_ASK_QUESTION", raising=False)
    blocker = build_ask_blocker(
        _q(options=()),
        reason="supervisor_question",
        missing_info=["m"],
        current_task_summary="t",
    )
    assert blocker.options is None
    assert "options" not in blocker.to_dict()


# ── ask_question(): caller-agnostic, reaches EscalationHalt with flag on ────


def test_ask_question_is_caller_agnostic_synthetic_site(monkeypatch):
    """A caller with no relationship to the Trajectory Supervisor can populate
    `questions` and reach EscalationHalt with the flag on — the mechanism is
    genuinely generic, not accidentally still coupled to supervisor internals."""
    monkeypatch.setenv("HARNESS_ASK_QUESTION", "1")
    state = _MockHarnessRunState()
    with pytest.raises(EscalationHalt) as exc_info:
        ask_question(
            _q(question="deploy target?", options=["us-east", "eu-west"]),
            reason="blocked_state",
            missing_info=["deploy target"],
            current_task_summary="synthetic test site",
            harness_run_state=state,
            run_id="run-synthetic",
        )
    blocker = exc_info.value.blocker
    assert blocker.questions is not None
    assert blocker.questions[0].question == "deploy target?"
    assert state.escalation_pending is True
    assert state.pending_escalation is blocker


def test_ask_question_flag_off_degrades_to_legacy_shape(monkeypatch):
    monkeypatch.delenv("HARNESS_ASK_QUESTION", raising=False)
    state = _MockHarnessRunState()
    with pytest.raises(EscalationHalt) as exc_info:
        ask_question(
            _q(question="deploy target?", options=["us-east", "eu-west"]),
            reason="blocked_state",
            missing_info=["deploy target"],
            current_task_summary="synthetic test site",
            harness_run_state=state,
            run_id="run-synthetic",
        )
    blocker = exc_info.value.blocker
    assert blocker.questions is None
    assert blocker.question == "deploy target?"


# ── Supervisor S3 ASK_USER refactor: flag-off byte-identical, flag-on batches ─


def _run_ask_user(*, options=("staging", "production"), harness_run_state=None, monkeypatch, ask_question_flag=None):
    monkeypatch.setenv("HARNESS_TRAJECTORY_SUPERVISOR", "1")
    if ask_question_flag is None:
        monkeypatch.delenv("HARNESS_ASK_QUESTION", raising=False)
    else:
        monkeypatch.setenv("HARNESS_ASK_QUESTION", "1" if ask_question_flag else "0")
    wm = WorldModel()
    wm.add_observation(Observation(id="o0", content="obs", source="test"))
    wm.add_belief(Belief(id="b0", statement="belief 0", confidence=0.8, derived_from=["o0"]))
    ss = StrategyState(completion_history=list(STALL_HISTORY))
    tg = TaskGraph(tasks=[Task(id="t1", description="primary widget", status="ACTIVE", abstraction_level=0)])
    directive = SupervisorDirective(
        action="ASK_USER",
        rationale="ambiguous target — need a human decision",
        question=UserQuestion(question="which environment?", options=list(options)),
    )
    return run_one_iteration(
        world_model=wm,
        diagnostics=_healthy_diagnostics(),
        hypothesis_set=HypothesisSet(active=[], eliminated=[]),
        task_graph=tg,
        failure_diagnostics=__import__("harness.failure_modes", fromlist=["FailureDiagnostics"]).FailureDiagnostics(),
        memory_state=MemoryState(),
        strategy_state=ss,
        harness_run_state=harness_run_state,
        run_id="run-q1-s3",
        step_count=0,
        supervisor_directive=directive,
    )


def test_supervisor_ask_user_flag_off_still_byte_identical_legacy_shape(monkeypatch):
    r = _run_ask_user(monkeypatch=monkeypatch)
    esc = r["escalation"]
    assert esc["reason"] == "supervisor_question"
    assert esc["question"] == "which environment?"
    assert esc["options"] == ["staging", "production"]
    assert "questions" not in esc


def test_supervisor_ask_user_flag_on_now_batches(monkeypatch):
    r = _run_ask_user(monkeypatch=monkeypatch, ask_question_flag=True)
    esc = r["escalation"]
    assert esc["reason"] == "supervisor_question"
    assert "question" not in esc
    assert "options" not in esc
    assert esc["questions"][0]["question"] == "which environment?"
    assert esc["questions"][0]["options"] == [{"label": "staging"}, {"label": "production"}]


def test_supervisor_ask_user_flag_on_with_out_of_range_options_falls_back_to_free_text(monkeypatch):
    # 1 option doesn't fit Q0's 2-4-option floor/ceiling — the supervisor's own
    # construction defensively drops to a free-text-only AskQuestion rather than
    # crashing the run on an LLM-authored options list that doesn't fit the cap.
    r = _run_ask_user(monkeypatch=monkeypatch, ask_question_flag=True, options=("only-one",))
    esc = r["escalation"]
    assert "options" not in esc["questions"][0]
