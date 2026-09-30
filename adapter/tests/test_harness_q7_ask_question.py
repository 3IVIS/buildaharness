"""Q7 of the internal plan — deterministic trigger sites.

Covers the two new zero-LLM-cost question builders (budget_exhausted, review_failure)
and their wiring into loop.py / output_contract.py, both with the ask-mode flag on and
off (flag-off byte-identical is asserted directly, not just implied).
"""

from __future__ import annotations

import pytest

from harness.ask_question import (
    build_budget_exhausted_question,
    build_review_failure_question,
    diagnose_review_failure_options,
)
from harness.diagnostics import Diagnostics
from harness.escalation import EscalationHalt
from harness.loop import run_one_iteration
from harness.memory import MemoryState
from harness.output_contract import (
    ContractCheckResult,
    OutputContract,
    completion_check_final,
    validate_output_contract,
)
from harness.review_gate import DimensionResult, ReviewResult, escalate_review_failure
from harness.task_graph import Task, TaskGraph
from harness.world_model import WorldModel


class _RunState:
    def __init__(self) -> None:
        self.run_id = "run-q7"


class _MockHarnessRunState:
    def __init__(self) -> None:
        self.escalation_pending = False
        self.pending_escalation = None
        self.supervisor_ask_user_count = 0
        self.memory_state = MemoryState()
        self.memory_state.journal = []


def _make_task_graph(n: int = 2) -> TaskGraph:
    tasks = [Task(id=f"t{i}", description=f"task {i}", status="PENDING") for i in range(n)]
    return TaskGraph(tasks=tasks)


def test_build_budget_exhausted_question_static_options() -> None:
    q = build_budget_exhausted_question(42)
    assert q.id == "budget-exhausted-resolution"
    assert q.options is not None
    labels = [o.label for o in q.options]
    assert labels == [
        "Continue with 10 more steps",
        "Stop and summarize progress so far",
        "Let me clarify the goal",
    ]


def _dim(dimension: str, reason: str = "r") -> DimensionResult:
    return DimensionResult(dimension=dimension, passed=False, reason=reason)  # type: ignore[arg-type]


def test_diagnose_review_failure_options_two_dimensions() -> None:
    opts = diagnose_review_failure_options([_dim("task_alignment"), _dim("output_contract_precheck")])
    assert opts is not None
    assert [o.label for o in opts] == [
        "Revise the proposed change to align with the current task description",
        "Adjust the proposed change to satisfy the output contract",
    ]


def test_diagnose_review_failure_options_single_dimension_falls_back() -> None:
    # One *dimension* even though two failures — not "more than one plausible fix" per Q7's scope.
    assert diagnose_review_failure_options([_dim("code_quality"), _dim("code_quality")]) is None
    assert diagnose_review_failure_options([]) is None


def test_diagnose_review_failure_options_too_many_dimensions_falls_back() -> None:
    all_five = [
        _dim(d)
        for d in (
            "task_alignment",
            "world_model_consistency",
            "output_contract_precheck",
            "code_quality",
            "hypothesis_compatibility",
        )
    ]
    assert diagnose_review_failure_options(all_five) is None  # 5 > MAX_OPTIONS_PER_QUESTION


def test_build_review_failure_question_wraps_options() -> None:
    opts = diagnose_review_failure_options([_dim("task_alignment"), _dim("code_quality")])
    assert opts is not None
    q = build_review_failure_question(opts)
    assert q.id == "review-failure-resolution"
    assert q.question == "The proposed change failed review. Which fix should I apply?"
    assert q.options == opts


def _failed_review(dims: list[str], escalate: bool = True) -> ReviewResult:
    return ReviewResult(
        passed=False,
        failed_dimensions=[_dim(d, f"{d} failed") for d in dims],
        consecutive_failures=2,
        escalation_triggered=escalate,
    )


def test_escalate_review_failure_ask_mode_off_is_a_plain_halt(monkeypatch) -> None:
    monkeypatch.delenv("HARNESS_ASK_QUESTION", raising=False)
    with pytest.raises(EscalationHalt) as exc:
        escalate_review_failure(_failed_review(["task_alignment", "code_quality"]), "do it", _RunState(), "r1")
    blocker = exc.value.blocker
    assert blocker.reason == "review_failure"
    assert blocker.questions is None
    assert blocker.question is None
    assert blocker.missing_info == ["task_alignment failed", "code_quality failed"]
    assert blocker.current_task_summary == "do it"


def test_escalate_review_failure_ask_mode_on_two_dimensions_builds_a_question(monkeypatch) -> None:
    monkeypatch.setenv("HARNESS_ASK_QUESTION", "true")
    with pytest.raises(EscalationHalt) as exc:
        escalate_review_failure(_failed_review(["task_alignment", "code_quality"]), "do it", _RunState(), "r1")
    blocker = exc.value.blocker
    assert blocker.reason == "review_failure"
    assert blocker.questions is not None
    assert len(blocker.questions) == 1
    assert len(blocker.questions[0].options) == 2


def test_escalate_review_failure_single_dimension_or_not_triggered_falls_back(monkeypatch) -> None:
    monkeypatch.setenv("HARNESS_ASK_QUESTION", "true")
    with pytest.raises(EscalationHalt) as exc:
        escalate_review_failure(_failed_review(["code_quality"]), "t", _RunState(), "r1")
    assert exc.value.blocker.questions is None

    # below the consecutive-failure limit: no halt at all
    escalate_review_failure(_failed_review(["task_alignment", "code_quality"], escalate=False), "t", _RunState())


def test_completion_check_final_halts_plainly_on_a_contract_violation() -> None:
    """The output-contract final check halts with review_failure and the violations, but (as TS) offers no question."""
    contract = OutputContract(required_sections=["a", "b"])
    with pytest.raises(EscalationHalt) as exc:
        completion_check_final(result={}, output_contract=contract, caller_state=None, harness_run_state=_RunState())
    blocker = exc.value.blocker
    assert blocker.reason == "review_failure"
    assert blocker.questions is None
    assert blocker.missing_info == ['required_sections: missing field "a"', 'required_sections: missing field "b"']

    assert completion_check_final({"a": 1, "b": 2}, contract, None, _RunState()).passed is True


def test_validate_output_contract_still_pure() -> None:
    contract = OutputContract(required_sections=["a"])
    result = validate_output_contract({}, contract, None)
    assert isinstance(result, ContractCheckResult)
    assert not result.passed
    assert result.violations


# ── loop.py's budget_exhausted sites, through run_one_iteration (Q7) ─────────────────────


def test_loop_budget_exhausted_flag_off_byte_identical_to_pre_q7(monkeypatch) -> None:
    monkeypatch.delenv("HARNESS_ASK_QUESTION", raising=False)
    run_state = _MockHarnessRunState()
    result = run_one_iteration(
        world_model=WorldModel(),
        diagnostics=Diagnostics(),
        hypothesis_set=None,
        task_graph=_make_task_graph(),
        memory_state=MemoryState(max_steps=1),
        step_count=1,  # == max_steps → escalate
        harness_run_state=run_state,
        run_id="run-q7-loop",
    )
    assert result.get("escalated") is True
    escalation = result.get("escalation", {})
    assert escalation.get("reason") == "budget_exhausted"
    assert escalation.get("questions") is None
    assert escalation.get("question") is None


def test_loop_budget_exhausted_ask_mode_on_builds_static_question(monkeypatch) -> None:
    monkeypatch.setenv("HARNESS_ASK_QUESTION", "true")
    run_state = _MockHarnessRunState()
    result = run_one_iteration(
        world_model=WorldModel(),
        diagnostics=Diagnostics(),
        hypothesis_set=None,
        task_graph=_make_task_graph(),
        memory_state=MemoryState(max_steps=1),
        step_count=1,
        harness_run_state=run_state,
        run_id="run-q7-loop",
    )
    assert result.get("escalated") is True
    escalation = result.get("escalation", {})
    assert escalation.get("reason") == "budget_exhausted"
    questions = escalation.get("questions")
    assert questions is not None and len(questions) == 1
    assert [o["label"] for o in questions[0]["options"]] == [
        "Continue with 10 more steps",
        "Stop and summarize progress so far",
        "Let me clarify the goal",
    ]


def test_loop_budget_exhausted_session_ask_mode_off_overrides_global_on(monkeypatch) -> None:
    # INV-29: a narrower scope (per-session ask_mode=False) can only turn structured mode
    # off, and must win over a broader-scope global flag that's on.
    monkeypatch.setenv("HARNESS_ASK_QUESTION", "true")
    run_state = _MockHarnessRunState()
    result = run_one_iteration(
        world_model=WorldModel(),
        diagnostics=Diagnostics(),
        hypothesis_set=None,
        task_graph=_make_task_graph(),
        memory_state=MemoryState(max_steps=1),
        step_count=1,
        harness_run_state=run_state,
        run_id="run-q7-loop",
        ask_mode=False,
    )
    escalation = result.get("escalation", {})
    assert escalation.get("questions") is None
