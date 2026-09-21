"""Q7 of the internal plan — deterministic trigger sites.

Covers the two new zero-LLM-cost question builders (budget_exhausted, review_failure)
and their wiring into loop.py / output_contract.py, both with the ask-mode flag on and
off (flag-off byte-identical is asserted directly, not just implied).
"""

from __future__ import annotations

from harness.ask_question import (
    build_budget_exhausted_question,
    build_review_failure_question,
    diagnose_review_failure_options,
)
from harness.diagnostics import Diagnostics
from harness.loop import run_one_iteration
from harness.memory import MemoryState
from harness.output_contract import (
    ContractCheckResult,
    OutputContract,
    completion_check_final,
    validate_output_contract,
)
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


def test_diagnose_review_failure_options_two_categories() -> None:
    violations = [
        "format_requirements: missing required field 'x'",
        "required_sections: missing section 'y'",
    ]
    opts = diagnose_review_failure_options(violations)
    assert opts is not None
    assert len(opts) == 2
    labels = {o.label for o in opts}
    assert "Adjust the output to match the required format" in labels
    assert "Add the missing required section(s) to the output" in labels


def test_diagnose_review_failure_options_single_category_falls_back() -> None:
    # Only one *category* even though two violation strings — not "more than one
    # plausible fix" per Q7's scope, so the caller should fall back to plain halt.
    violations = [
        "format_requirements: missing required field 'x'",
        "format_requirements: result length 500 exceeds max_length 100",
    ]
    assert diagnose_review_failure_options(violations) is None


def test_diagnose_review_failure_options_no_recognized_category() -> None:
    assert diagnose_review_failure_options(["something unrecognized"]) is None


def test_build_review_failure_question_wraps_options() -> None:
    opts = diagnose_review_failure_options(
        ["required_sections: missing section 'a'", "interface_constraints: missing required field 'b'"]
    )
    assert opts is not None
    q = build_review_failure_question(opts)
    assert q.id == "review-failure-resolution"
    assert q.options == opts


def test_completion_check_final_ask_mode_off_byte_identical_to_pre_q7(monkeypatch) -> None:
    monkeypatch.delenv("HARNESS_ASK_QUESTION", raising=False)
    contract = OutputContract(required_sections=["a"], format_requirements={"required_fields": ["x"]})
    run_state = _RunState()
    try:
        completion_check_final(
            result={},
            output_contract=contract,
            caller_state=None,
            harness_run_state=run_state,
            session_ask_mode=None,
        )
        raised = False
    except Exception as exc:  # EscalationHalt
        raised = True
        blocker = exc.blocker  # type: ignore[attr-defined]
        assert blocker.reason == "review_failure"
        assert blocker.questions is None
        assert blocker.question is None
    assert raised


def test_completion_check_final_ask_mode_on_two_categories_builds_questions(monkeypatch) -> None:
    monkeypatch.setenv("HARNESS_ASK_QUESTION", "true")
    contract = OutputContract(required_sections=["a"], format_requirements={"required_fields": ["x"]})
    run_state = _RunState()
    try:
        completion_check_final(
            result={},
            output_contract=contract,
            caller_state=None,
            harness_run_state=run_state,
            session_ask_mode=None,
        )
        raised = False
    except Exception as exc:  # EscalationHalt
        raised = True
        blocker = exc.blocker  # type: ignore[attr-defined]
        assert blocker.reason == "review_failure"
        assert blocker.questions is not None
        assert len(blocker.questions) == 1
        assert len(blocker.questions[0].options) == 2
    assert raised


def test_completion_check_final_single_violation_falls_back_even_with_ask_mode_on(monkeypatch) -> None:
    monkeypatch.setenv("HARNESS_ASK_QUESTION", "true")
    contract = OutputContract(required_sections=["a"])
    run_state = _RunState()
    try:
        completion_check_final(
            result={},
            output_contract=contract,
            caller_state=None,
            harness_run_state=run_state,
        )
        raised = False
    except Exception as exc:
        raised = True
        blocker = exc.blocker  # type: ignore[attr-defined]
        assert blocker.questions is None
    assert raised


def test_validate_output_contract_still_pure() -> None:
    # Regression anchor: completion_check_final's new branching must not change what
    # validate_output_contract() itself returns.
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
