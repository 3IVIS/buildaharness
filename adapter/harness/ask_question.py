"""
Ask-question primitive — Q1 of plans/ask_question_and_plan_mode_plan.html.

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

from .escalation import AskQuestion, EscalationReason, SurfaceBlocker, escalate

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
