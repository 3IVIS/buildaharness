"""
Q0 acceptance tests — shared question/answer types, both twins, inert.

Plan: plans/ask_question_and_plan_mode_plan.html, Phase Q0.

Nothing in this file constructs a populated `questions` field outside these
test fixtures — no behavior change is possible at this phase (see plan Q0).

Run: pytest adapter/tests/test_harness_q0_ask_question.py -v --noconftest
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.escalation import (
    AskAnswer,
    AskQuestion,
    AskQuestionOption,
    AskResponse,
    SurfaceBlocker,
    batch_questions,
    make_questions_batch,
    refine_deferred_batch,
    validate_ask_response,
)

# ─── INV-26: old shape stays byte-identical ───────────────────────────────────


def test_inv26_blocker_without_questions_has_no_questions_key():
    blocker = SurfaceBlocker(
        reason="cannot_make_progress",
        missing_info=["need more context"],
        current_task_summary="stuck task",
    )
    d = blocker.to_dict()
    assert "questions" not in d
    restored = SurfaceBlocker.from_dict(d)
    assert restored.questions is None


# ─── 4-question batch mixing all three answer kinds ───────────────────────────


def _four_question_batch() -> list[AskQuestion]:
    return [
        AskQuestion(
            id="q1",
            question="Pick a color",
            options=[AskQuestionOption(label="Red"), AskQuestionOption(label="Blue", recommended=True)],
        ),
        AskQuestion(
            id="q2",
            question="Pick as many as apply",
            allow_multiple=True,
            options=[AskQuestionOption(label="A"), AskQuestionOption(label="B"), AskQuestionOption(label="C")],
        ),
        AskQuestion(id="q3", question="Free text only, no options"),
        AskQuestion(
            id="q4",
            question="One with a preview",
            options=[AskQuestionOption(label="X", preview="preview text"), AskQuestionOption(label="Y")],
        ),
    ]


def test_four_question_batch_round_trips_through_blocker():
    questions = _four_question_batch()
    blocker = SurfaceBlocker(
        reason="supervisor_question", missing_info=[], current_task_summary="drafting", questions=questions
    )
    d = blocker.to_dict()
    restored = SurfaceBlocker.from_dict(d)
    assert restored.questions is not None
    assert len(restored.questions) == 4
    assert restored.questions[1].allow_multiple is True
    assert restored.questions[2].options is None
    assert restored.questions[3].options[0].preview == "preview text"


def test_full_ask_response_validates_against_batch_all_three_kinds():
    questions = _four_question_batch()
    response = AskResponse(
        answers=[
            AskAnswer(question_id="q1", kind="selected", selected_labels=["Blue"]),
            AskAnswer(question_id="q2", kind="selected", selected_labels=["A", "C"]),
            AskAnswer(question_id="q3", kind="free_text", free_text="hello"),
            AskAnswer(question_id="q4", kind="selected_with_edit", selected_labels=["X"], edit_text="but faster"),
        ]
    )
    validate_ask_response(questions, response)  # must not raise

    rd = response.to_dict()
    restored = AskResponse.from_dict(rd)
    assert restored.answers[3].edit_text == "but faster"


# ─── Construction-time rejection of invalid combinations ─────────────────────


def test_rejects_preview_combined_with_allow_multiple():
    with pytest.raises(ValueError, match=r"preview.*allow_multiple"):
        AskQuestion(
            id="bad",
            question="x",
            allow_multiple=True,
            options=[AskQuestionOption(label="A", preview="p"), AskQuestionOption(label="B")],
        )


def test_rejects_one_option_array():
    with pytest.raises(ValueError, match="between 2 and 4"):
        AskQuestion(id="bad", question="x", options=[AskQuestionOption(label="A")])


def test_rejects_five_option_array():
    with pytest.raises(ValueError, match="between 2 and 4"):
        AskQuestion(id="bad", question="x", options=[AskQuestionOption(label=str(i)) for i in range(5)])


def test_rejects_fifth_question_in_a_single_batch():
    five_questions = [AskQuestion(id=f"q{i}", question=f"question {i}") for i in range(5)]
    with pytest.raises(ValueError, match="4-question cap"):
        make_questions_batch(five_questions)
    with pytest.raises(ValueError, match="4-question cap"):
        SurfaceBlocker(
            reason="cannot_make_progress", missing_info=[], current_task_summary="x", questions=five_questions
        )


def test_rejects_answer_kind_whose_data_does_not_match_its_own_shape():
    with pytest.raises(ValueError, match='kind "free_text" requires non-empty free_text'):
        AskAnswer(question_id="q1", kind="free_text", selected_labels=["A"])


def test_rejects_allow_multiple_false_question_receiving_more_than_one_label():
    questions = [
        AskQuestion(id="q1", question="Pick one", options=[AskQuestionOption(label="A"), AskQuestionOption(label="B")])
    ]
    response = AskResponse(answers=[AskAnswer(question_id="q1", kind="selected", selected_labels=["A", "B"])])
    with pytest.raises(ValueError, match="does not allow multiple selections"):
        validate_ask_response(questions, response)


def test_rejects_resolve_payload_missing_an_answer():
    questions = [
        AskQuestion(id="q1", question="Pick one"),
        AskQuestion(id="q2", question="Pick another"),
    ]
    response = AskResponse(answers=[AskAnswer(question_id="q1", kind="free_text", free_text="ok")])
    with pytest.raises(ValueError, match=r"missing answers.*q2"):
        validate_ask_response(questions, response)


# ─── INV-37: sequential batching for more than 4 candidate questions ─────────


def test_inv37_batches_top_four_and_defers_the_rest_unconstructed():
    candidates = [AskQuestion(id=f"c{i}", question=f"candidate {i}") for i in range(7)]
    batch, deferred = batch_questions(candidates)
    assert [q.id for q in batch] == ["c0", "c1", "c2", "c3"]
    assert [q.id for q in deferred] == ["c4", "c5", "c6"]
    # batch two of 3 never gets rejected the way a 5th question in ONE batch would —
    # it's still a valid, separately-constructible batch.
    make_questions_batch(deferred)  # must not raise


def test_inv37_refines_deferred_batch_dropping_moot_questions():
    candidates = [AskQuestion(id=f"c{i}", question=f"candidate {i}") for i in range(7)]
    _, deferred = batch_questions(candidates)
    moot_ids = {"c4", "c5"}
    batch_two = refine_deferred_batch(deferred, lambda q: q.id in moot_ids)
    assert [q.id for q in batch_two] == ["c6"]
