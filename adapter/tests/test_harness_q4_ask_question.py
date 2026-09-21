"""
Q4 acceptance tests — answer shapes threaded into constraint propagation.

Plan: the internal plan, Phase Q4.

Run: pytest adapter/tests/test_harness_q4_ask_question.py -v --noconftest
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.caller_state import CallerState, describe_ask_answer, inject_clarification
from harness.escalation import AskAnswer, AskQuestion, AskQuestionOption

QUESTIONS = [
    AskQuestion(
        id="q1",
        question="Which environment?",
        options=[AskQuestionOption(label="staging"), AskQuestionOption(label="prod")],
    ),
    AskQuestion(
        id="q2",
        question="Any caveats?",
        options=[AskQuestionOption(label="None"), AskQuestionOption(label="Rate limit")],
    ),
    AskQuestion(id="q3", question="Anything else we should know?"),
]

ANSWERS = [
    AskAnswer(question_id="q1", kind="selected", selected_labels=["staging"]),
    AskAnswer(
        question_id="q2", kind="selected_with_edit", selected_labels=["Rate limit"], edit_text="only above 100rps"
    ),
    AskAnswer(question_id="q3", kind="free_text", free_text="Ping me before deploying"),
]


def test_describe_ask_answer_renders_each_kind_distinctly():
    rendered = [describe_ask_answer(q, a) for q, a in zip(QUESTIONS, ANSWERS, strict=True)]
    assert rendered[0] == "Selected — Which environment?: staging"
    assert rendered[1] == "Selected with note — Any caveats?: Rate limit (note: only above 100rps)"
    assert rendered[2] == "Free-text answer — Anything else we should know?: Ping me before deploying"
    assert len(set(rendered)) == 3


def test_describe_ask_answer_falls_back_to_question_id():
    assert describe_ask_answer(None, ANSWERS[0]) == "Selected — q1: staging"


def test_inject_clarification_appends_one_entry_per_answer_preserving_kind():
    caller_state = CallerState(current_constraints=["existing constraint"])
    update = {
        "clarification_answers": [a.to_dict() for a in ANSWERS],
        "ask_questions": [q.to_dict() for q in QUESTIONS],
    }
    inject_clarification(caller_state, update)

    assert caller_state.current_constraints == [
        "existing constraint",
        "Selected — Which environment?: staging",
        "Selected with note — Any caveats?: Rate limit (note: only above 100rps)",
        "Free-text answer — Anything else we should know?: Ping me before deploying",
    ]
    assert caller_state.constraints_changed is True


def test_inject_clarification_preserves_raw_structured_payload_in_history():
    caller_state = CallerState()
    update = {
        "clarification_answers": [a.to_dict() for a in ANSWERS],
        "ask_questions": [q.to_dict() for q in QUESTIONS],
    }
    inject_clarification(caller_state, update)
    recorded = caller_state.clarification_history[0]["clarification_answers"]
    assert [a["kind"] for a in recorded] == ["selected", "selected_with_edit", "free_text"]


def test_inject_clarification_works_without_ask_questions_list():
    caller_state = CallerState()
    inject_clarification(caller_state, {"clarification_answers": [ANSWERS[2].to_dict()]})
    assert caller_state.current_constraints == ["Free-text answer — q3: Ping me before deploying"]


def test_plain_current_constraints_replacement_untouched():
    caller_state = CallerState(current_constraints=["old"])
    inject_clarification(caller_state, {"current_constraints": ["new"]})
    assert caller_state.current_constraints == ["new"]


def test_free_text_answer_accepted_for_a_question_with_options_set():
    # Section 3-F / Q4: the standing free-text fallback is always available, regardless of
    # whether the question defines an options list.
    q_with_options = QUESTIONS[0]
    free_text_answer = AskAnswer(question_id="q1", kind="free_text", free_text="Something not in the option list")
    # Construction succeeds (no cross-check against the question's options at all).
    assert free_text_answer.free_text == "Something not in the option list"
    rendered = describe_ask_answer(q_with_options, free_text_answer)
    assert rendered == "Free-text answer — Which environment?: Something not in the option list"
