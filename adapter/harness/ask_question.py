"""
Ask-question primitive — Q1 of the internal plan.

A generic, independently invocable module that builds a batched-questions (Q0)
SurfaceBlocker and halts the run through the existing escalate()/EscalationHalt
plumbing. It is **not** owned by, imported by, or gated behind the Trajectory
Supervisor module — the supervisor's own ASK_USER handling (S3, in loop.py) is
refactored to call this shared primitive instead of constructing its own
question/options pair inline, becoming one caller among several rather than
the only one. Any other deterministic halt site (Q7) can call it directly.

Three independent control points (Section 5a-1 of the HITL comparison report),
each of which can only turn structured questions OFF relative to a broader
scope's setting, never ON when a broader scope already said off (INV-29):

  1. Global flag  — HARNESS_ASK_QUESTION env var (ask_mode_globally_enabled()).
  2. Per-session  — `session_ask_mode=False` passed by a caller (e.g. a
                     per-turn override).
  3. Per-call-site — `structured=False` passed straight to ask_question()/
                      build_ask_blocker().

When the effective mode resolves to disabled, build_ask_blocker() does not
drop the question entirely — it collapses the (by convention, single) first
AskQuestion down to the pre-Q0 SurfaceBlocker.question/.options shape, so a
caller that used to build that shape directly (the supervisor's S3 ASK_USER
path, before this refactor) reproduces its exact prior output byte-for-byte
while the flag sits at its default (DEFAULT_ASK_MODE = "disabled").
"""

from __future__ import annotations

import os
from collections.abc import Sequence
from typing import Any

from .escalation import (
    MAX_OPTIONS_PER_QUESTION,
    AskQuestion,
    AskQuestionOption,
    EscalationReason,
    SurfaceBlocker,
    escalate,
)

_FLAG_ENV = "HARNESS_ASK_QUESTION"
_TRUTHY = frozenset({"1", "true", "yes", "on", "enabled"})

DEFAULT_ASK_MODE = "disabled"


def ask_mode_globally_enabled() -> bool:
    """True iff HARNESS_ASK_QUESTION is set to a truthy value. Default OFF (DEFAULT_ASK_MODE)."""
    return os.environ.get(_FLAG_ENV, "").strip().lower() in _TRUTHY


def resolve_ask_mode(
    *,
    session_ask_mode: bool | None = None,
    structured: bool = True,
) -> bool:
    """Resolve the effective structured-question mode from all three control points.

    INV-29: the effective mode is the most restrictive (AND) of the three — a
    narrower scope can only turn structured mode off relative to a broader
    scope's setting, never on when a broader scope said off. Concretely: a
    False at any tier forces the result False; a True/None at a narrower tier
    never overrides an OFF broader tier.
    """
    if not structured:
        return False
    if session_ask_mode is False:
        return False
    return ask_mode_globally_enabled()


def build_ask_blocker(
    questions: Sequence[AskQuestion],
    *,
    reason: EscalationReason,
    missing_info: list[str],
    current_task_summary: str,
    structured: bool = True,
    session_ask_mode: bool | None = None,
) -> SurfaceBlocker:
    """Build a SurfaceBlocker for a batch of questions, without escalating.

    When the effective structured mode (resolve_ask_mode) is enabled, the
    blocker carries Q0's `questions` batch. When disabled, this degrades to
    the pre-Q0 single question/options shape, collapsed from the first
    question in `questions` — never silently dropped — or a plain
    missing_info-only halt when `questions` is empty.
    """
    effective = resolve_ask_mode(session_ask_mode=session_ask_mode, structured=structured)
    if effective and questions:
        return SurfaceBlocker(
            reason=reason,
            missing_info=missing_info,
            current_task_summary=current_task_summary,
            questions=list(questions),
        )

    first = questions[0] if questions else None
    return SurfaceBlocker(
        reason=reason,
        missing_info=missing_info,
        current_task_summary=current_task_summary,
        question=first.question if first is not None else None,
        options=([o.label for o in first.options] if first is not None and first.options else None),
    )


def ask_question(
    questions: Sequence[AskQuestion],
    *,
    reason: EscalationReason,
    missing_info: list[str],
    current_task_summary: str,
    harness_run_state: Any,
    run_id: str,
    structured: bool = True,
    session_ask_mode: bool | None = None,
) -> None:
    """Build a batched-questions SurfaceBlocker and halt via escalate()/EscalationHalt.

    Thin wrapper, caller-agnostic: any deterministic halt site can call this
    directly, not just the Trajectory Supervisor. Always raises EscalationHalt
    (mirrors escalate()'s own contract) — callers catch it exactly as they
    already catch a plain escalate() call.
    """
    blocker = build_ask_blocker(
        questions,
        reason=reason,
        missing_info=missing_info,
        current_task_summary=current_task_summary,
        structured=structured,
        session_ask_mode=session_ask_mode,
    )
    escalate(blocker, harness_run_state, run_id)


# ── Q7 — deterministic-site question builders ────────────────────────────────
#
# Static, templated question content for the two deterministic (non-supervisor) halt
# sites the internal plan's Q7 wires: budget_exhausted (loop.py)
# and review_failure (output_contract.py). Both builders are pure and add no LLM call —
# the options are fixed text (budget_exhausted) or mechanically derived from a caller's
# already-computed diagnostics (review_failure), never drafted by a model.

_DEFAULT_BUDGET_EXTENSION_STEPS = 10


def build_budget_exhausted_question(step_count: int, extension: int = _DEFAULT_BUDGET_EXTENSION_STEPS) -> AskQuestion:
    """Static options for a budget_exhausted halt — zero extra LLM cost.

    A genuinely discrete, enumerable set of resolutions exists here (per Q7's scope), so
    this is always offered as a question when the effective ask mode is on — no "does a
    discrete option set even exist" branching, unlike review_failure below.
    """
    return AskQuestion(
        id="budget-exhausted-resolution",
        question=f"The step budget is exhausted (at step {step_count}). How should I proceed?",
        options=[
            AskQuestionOption(label=f"Continue with {extension} more steps"),
            AskQuestionOption(label="Stop and summarize progress so far"),
            AskQuestionOption(label="Let me clarify the goal"),
        ],
    )


# Maps the category prefix each output_contract.py check_* function stamps onto its own
# violation strings (see check_format_requirements/check_required_sections/
# check_interface_constraints/check_caller_specific_constraints) to a static, human-facing
# candidate fix. Adding a new check_* category later just needs an entry here to become
# askable; until then its violations still surface via missing_info as they do today.
_REVIEW_VIOLATION_FIXES: dict[str, str] = {
    "format_requirements": "Adjust the output to match the required format",
    "required_sections": "Add the missing required section(s) to the output",
    "interface_constraints": "Fix the interface field(s) that are missing or have the wrong type",
    "caller_constraint": "Revise the output to satisfy the caller-specific constraint(s)",
}


def diagnose_review_failure_options(violations: Sequence[str]) -> list[AskQuestionOption] | None:
    """Deterministically categorize output-contract violations into candidate fixes (Q7).

    Groups `validate_output_contract()`'s violation strings by the dimension-prefix each
    check_* function already stamps on them, and returns one static, templated fix option
    per distinct category present — no LLM call, nothing drafted from the violation text
    itself. Returns None (not an empty list) when fewer than two distinct categories are
    present (a single diagnosed problem isn't "more than one plausible fix" — Q7's scope
    text) or when there are more categories than Q0's 4-option-per-question ceiling can
    hold (silently dropping one would be worse than falling back) — both cases leave the
    call site to fall back to today's plain missing_info halt, unchanged.
    """
    categories: list[str] = []
    for v in violations:
        prefix = v.split(":", 1)[0].strip()
        key = "caller_constraint" if prefix.startswith("caller_constraint") else prefix
        if key in _REVIEW_VIOLATION_FIXES and key not in categories:
            categories.append(key)
    if len(categories) < 2 or len(categories) > MAX_OPTIONS_PER_QUESTION:
        return None
    return [AskQuestionOption(label=_REVIEW_VIOLATION_FIXES[c]) for c in categories]


def build_review_failure_question(options: Sequence[AskQuestionOption]) -> AskQuestion:
    """Wrap diagnose_review_failure_options()'s output into an AskQuestion. Pure."""
    return AskQuestion(
        id="review-failure-resolution",
        question="The output failed review. Which fix should I apply?",
        options=list(options),
    )
