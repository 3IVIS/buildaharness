"""
Escalation with surface_blocker — P7.3.

escalate() is the structured halt point at which the harness surfaces minimum
required information to the human and pauses the run. After a human response
arrives via the resume endpoint, await_clarification() retrieves it and the
constraint change propagation path (P7.2) handles the update.

SurfaceBlocker carries only human-readable context — no raw world_model dumps,
no hypothesis_set, no evidence_store entries.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, Literal

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

EscalationReason = Literal[
    "blocked_state",
    "cannot_make_progress",
    "budget_exhausted",
    "review_failure",
    "action_requires_compressed_state",
    "supervisor_question",
]

# Q0 — shared question/answer types (batched ask-question mechanism). These caps mirror
# the live AskUserQuestion tool definition exactly (Section 1b of the HITL comparison
# report flagged both as "easy to miss"): a hard ceiling on one SurfaceBlocker's
# questions, and a floor/ceiling on any one question's options. A caller with more than
# MAX_QUESTIONS_PER_BATCH genuinely-needed questions is a sequential-batching problem
# (see batch_questions()/refine_deferred_batch(), INV-37), never a reason to raise these.
MAX_QUESTIONS_PER_BATCH = 4
MIN_OPTIONS_PER_QUESTION = 2
MAX_OPTIONS_PER_QUESTION = 4

AskAnswerKind = Literal["selected", "selected_with_edit", "free_text"]


@dataclass
class AskQuestionOption:
    """One selectable choice within an AskQuestion.

    `preview` and `allowMultiple` are mutually exclusive on the owning question,
    mirroring the live AskUserQuestion tool schema's own constraint.
    """

    label: str
    description: str | None = None
    preview: str | None = None
    recommended: bool = False

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {"label": self.label}
        if self.description is not None:
            d["description"] = self.description
        if self.preview is not None:
            d["preview"] = self.preview
        if self.recommended:
            d["recommended"] = self.recommended
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> AskQuestionOption:
        return cls(
            label=d["label"],
            description=d.get("description"),
            preview=d.get("preview"),
            recommended=bool(d.get("recommended", False)),
        )


@dataclass
class AskQuestion:
    """One question within a batched ask-question SurfaceBlocker.

    `options` is optional — omitting it entirely (not a 1-option list) is how a
    free-text-only question is expressed. `allow_free_text` only controls whether
    free text is advertised as the expected path; the standing free-text fallback
    itself is a rendering-layer guarantee (Q4), not something this type enforces.
    """

    id: str
    question: str
    header: str | None = None
    options: list[AskQuestionOption] | None = None
    allow_multiple: bool = False
    allow_free_text: bool = True

    def __post_init__(self) -> None:
        if self.options is not None:
            if not (MIN_OPTIONS_PER_QUESTION <= len(self.options) <= MAX_OPTIONS_PER_QUESTION):
                raise ValueError(
                    f'AskQuestion "{self.id}": options must have between '
                    f"{MIN_OPTIONS_PER_QUESTION} and {MAX_OPTIONS_PER_QUESTION} entries, "
                    f"got {len(self.options)}"
                )
            if self.allow_multiple and any(o.preview is not None for o in self.options):
                raise ValueError(
                    f'AskQuestion "{self.id}": options with "preview" cannot be combined with allow_multiple'
                )

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {"id": self.id, "question": self.question}
        if self.header is not None:
            d["header"] = self.header
        if self.options is not None:
            d["options"] = [o.to_dict() for o in self.options]
        if self.allow_multiple:
            d["allowMultiple"] = self.allow_multiple
        if not self.allow_free_text:
            d["allowFreeText"] = self.allow_free_text
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> AskQuestion:
        opts = d.get("options")
        return cls(
            id=d["id"],
            question=d["question"],
            header=d.get("header"),
            options=[AskQuestionOption.from_dict(o) for o in opts] if opts is not None else None,
            allow_multiple=bool(d.get("allowMultiple", False)),
            allow_free_text=bool(d.get("allowFreeText", True)),
        )


def make_questions_batch(questions: Sequence[AskQuestion]) -> list[AskQuestion]:
    """Validate a batch of questions against INV-34's per-batch cap.

    Each AskQuestion already validated its own options cap at construction
    (__post_init__); this only enforces the batch-level MAX_QUESTIONS_PER_BATCH
    ceiling. Raises loudly rather than silently truncating.
    """
    if len(questions) > MAX_QUESTIONS_PER_BATCH:
        raise ValueError(
            f"questions batch exceeds the {MAX_QUESTIONS_PER_BATCH}-question cap "
            f"(got {len(questions)}); use batch_questions() to split into sequential batches"
        )
    return list(questions)


@dataclass
class AskAnswer:
    """One answer within an AskResponse.

    `kind` determines which of `selected_labels`/`edit_text`/`free_text` is
    populated — enforced at construction so a payload can never mix shapes
    (e.g. a `free_text` answer carrying `selected_labels`).
    """

    question_id: str
    kind: AskAnswerKind
    selected_labels: list[str] | None = None
    edit_text: str | None = None
    free_text: str | None = None

    def __post_init__(self) -> None:
        if self.kind == "selected":
            if not self.selected_labels:
                raise ValueError(
                    f'AskAnswer for "{self.question_id}": kind "selected" requires at least one selected label'
                )
            if self.edit_text is not None or self.free_text is not None:
                raise ValueError(
                    f'AskAnswer for "{self.question_id}": kind "selected" must not carry edit_text/free_text'
                )
        elif self.kind == "selected_with_edit":
            if not self.selected_labels:
                raise ValueError(
                    f'AskAnswer for "{self.question_id}": kind "selected_with_edit" requires at least '
                    "one selected label"
                )
            if not self.edit_text:
                raise ValueError(
                    f'AskAnswer for "{self.question_id}": kind "selected_with_edit" requires non-empty edit_text'
                )
            if self.free_text is not None:
                raise ValueError(
                    f'AskAnswer for "{self.question_id}": kind "selected_with_edit" must not carry free_text'
                )
        elif self.kind == "free_text":
            if not self.free_text:
                raise ValueError(f'AskAnswer for "{self.question_id}": kind "free_text" requires non-empty free_text')
            if self.selected_labels is not None or self.edit_text is not None:
                raise ValueError(
                    f'AskAnswer for "{self.question_id}": kind "free_text" must not carry selected_labels/edit_text'
                )
        else:
            raise ValueError(f'AskAnswer for "{self.question_id}": unknown kind "{self.kind}"')

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {"questionId": self.question_id, "kind": self.kind}
        if self.selected_labels is not None:
            d["selectedLabels"] = list(self.selected_labels)
        if self.edit_text is not None:
            d["editText"] = self.edit_text
        if self.free_text is not None:
            d["freeText"] = self.free_text
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> AskAnswer:
        labels = d.get("selectedLabels")
        return cls(
            question_id=d["questionId"],
            kind=d["kind"],
            selected_labels=list(labels) if labels is not None else None,
            edit_text=d.get("editText"),
            free_text=d.get("freeText"),
        )


@dataclass
class AskResponse:
    """The one client submit resolving an entire questions batch (INV-27)."""

    answers: list[AskAnswer]

    def to_dict(self) -> dict[str, Any]:
        return {"answers": [a.to_dict() for a in self.answers]}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> AskResponse:
        return cls(answers=[AskAnswer.from_dict(a) for a in d.get("answers", [])])


def validate_ask_response(questions: Sequence[AskQuestion], response: AskResponse) -> None:
    """Cross-check a resolve payload against the batch of questions it answers.

    Every question must have exactly one matching answer; an allow_multiple=False
    question must not receive more than one selected label. Raises ValueError on
    the first violation found — used by callers resolving a batch (Q2/Q3), not by
    AskAnswer/AskQuestion construction themselves.
    """
    by_id = {q.id: q for q in questions}
    answered_ids: set[str] = set()
    for answer in response.answers:
        question = by_id.get(answer.question_id)
        if question is None:
            raise ValueError(f'AskResponse: answer references unknown question id "{answer.question_id}"')
        if (
            not question.allow_multiple
            and answer.kind in ("selected", "selected_with_edit")
            and answer.selected_labels is not None
            and len(answer.selected_labels) > 1
        ):
            raise ValueError(f'AskResponse: question "{question.id}" does not allow multiple selections')
        answered_ids.add(answer.question_id)
    missing = [q.id for q in questions if q.id not in answered_ids]
    if missing:
        raise ValueError(f"AskResponse: missing answers for question id(s) {', '.join(missing)}")


def batch_questions(
    candidates: Sequence[AskQuestion], cap: int = MAX_QUESTIONS_PER_BATCH
) -> tuple[list[AskQuestion], list[AskQuestion]]:
    """Split ranked candidates into a first batch (top `cap`) and an ordered deferred remainder.

    `candidates` must already be ranked by the caller (most plan-changing first) —
    this only enforces INV-34's per-batch cap, it does not rank (INV-37).
    """
    if cap < 1:
        raise ValueError("cap must be >= 1")
    return list(candidates[:cap]), list(candidates[cap:])


def refine_deferred_batch(
    deferred: Sequence[AskQuestion],
    is_moot: Callable[[AskQuestion], bool],
    cap: int = MAX_QUESTIONS_PER_BATCH,
) -> list[AskQuestion]:
    """Re-evaluate a deferred list after folding in an earlier batch's answers.

    `is_moot` is caller-supplied domain logic (e.g. "does batch one's answer
    already resolve this question") — this only filters and re-applies INV-34's
    cap (INV-37); it never decides mootness itself.
    """
    still_material = [q for q in deferred if not is_moot(q)]
    return still_material[:cap]


@dataclass
class SurfaceBlocker:
    """Minimum structured information surfaced to a human when the harness halts.

    Carries exactly: reason, missing_info, current_task_summary, escalated_at.
    Must not contain raw world_model JSON, hypothesis_set data, or evidence_store
    entries — the escalation is human-readable, not a debug dump.
    """

    reason: EscalationReason
    missing_info: list[str]
    current_task_summary: str
    escalated_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    # Trajectory Supervisor ASK_USER (S3) — a structured question surfaced to the human,
    # mirroring this harness's own AskUserQuestion shape. Both default None; when unset
    # they are omitted from to_dict() entirely, so a plain escalation's payload stays
    # byte-identical to pre-S3.
    question: str | None = None
    options: list[str] | None = None
    # Q0 — batched ask-question mechanism (INV-26): default None, kept alongside the
    # single question/options fields above for the rollout window. When unset,
    # serialization and rendering are byte-identical to a pre-Q0 SurfaceBlocker.
    questions: list[AskQuestion] | None = None

    def __post_init__(self) -> None:
        if self.questions is not None:
            self.questions = make_questions_batch(self.questions)

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "reason": self.reason,
            "missing_info": list(self.missing_info),
            "current_task_summary": self.current_task_summary,
            "escalated_at": self.escalated_at.isoformat(),
        }
        if self.question is not None:
            d["question"] = self.question
        if self.options is not None:
            d["options"] = list(self.options)
        if self.questions is not None:
            d["questions"] = [q.to_dict() for q in self.questions]
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> SurfaceBlocker:
        opts = d.get("options")
        questions = d.get("questions")
        return cls(
            reason=d["reason"],
            missing_info=d.get("missing_info", []),
            current_task_summary=d.get("current_task_summary", ""),
            escalated_at=datetime.fromisoformat(d["escalated_at"]) if d.get("escalated_at") else datetime.now(UTC),
            question=d.get("question"),
            options=list(opts) if opts is not None else None,
            questions=[AskQuestion.from_dict(q) for q in questions] if questions is not None else None,
        )


class EscalationHalt(Exception):
    """Non-error exception raised by escalate() to halt the loop.

    The loop runner catches this and converts the run to a paused state.
    """

    def __init__(self, blocker: SurfaceBlocker) -> None:
        self.blocker = blocker
        super().__init__(f"Escalation halt: {blocker.reason}")


def escalate(
    surface_blocker: SurfaceBlocker,
    harness_run_state: Any,
    run_id: str,
) -> None:
    """Halt the harness run and surface the blocker for human review.

    Steps:
    1. Set harness_run_state.escalation_pending = True
    2. Store surface_blocker as harness_run_state.pending_escalation
    3. Emit a structured log entry to the execution_journal
    4. Raise EscalationHalt — caught by the loop runner to pause the run

    Note: DB persistence (step 4 in the plan) is handled by the loop runner
    after catching EscalationHalt, since save() is async and escalate() is sync.
    """
    harness_run_state.escalation_pending = True
    harness_run_state.pending_escalation = surface_blocker

    if hasattr(harness_run_state, "memory_state") and harness_run_state.memory_state is not None:
        ms = harness_run_state.memory_state
        if hasattr(ms, "journal"):
            ms.journal.append(
                {
                    "action_class": "escalation",
                    "reason": surface_blocker.reason,
                    "missing_info": surface_blocker.missing_info,
                    "run_id": run_id,
                    "escalated_at": surface_blocker.escalated_at.isoformat(),
                }
            )

    raise EscalationHalt(surface_blocker)


async def await_clarification(run_id: str, db: AsyncSession) -> Any | None:
    """Check if a human response has been posted for the escalated run.

    Returns None if no response is available yet — the caller (resume endpoint)
    should exit early and let the caller retry.

    Returns a PendingUpdate when a response is present. Clears pending_clarification
    and escalation_pending on HarnessRunState before returning.
    """
    from .external_updates import PendingUpdate
    from .state_store import load as _load
    from .state_store import save as _save

    state = await _load(run_id, db)
    if state is None:
        return None

    if state.pending_clarification is None:
        return None

    payload = dict(state.pending_clarification)
    update_type = payload.pop("update_type", "clarification")

    state.pending_clarification = None
    state.escalation_pending = False

    if hasattr(state, "caller_state"):
        state.caller_state.escalation_pending = False
        state.caller_state.pending_clarification = None

    await _save(run_id, state, db)

    return PendingUpdate(update_type=update_type, payload=payload)
