"""The write gate (M2 ``admitCandidate``) in Python.

Semantic judgement is *injected*: this module never decides whether text is a secret or an
instruction. It consumes the three judgement fields the extractor (or an injected ``Judge``)
produced. A missing judgement fails closed. No regex, no keyword lists (D2).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace

from .model import CandidateJudgement, Fact

# A judge for candidates that arrive without a judgement. None or an exception means "missing".
Judge = Callable[[Fact], Awaitable[CandidateJudgement | None]]


@dataclass(frozen=True)
class AdmitDecision:
    action: str  # 'admit' | 'session' | 'flag' | 'drop'
    fact: Fact


def admit_candidate(candidate: Fact, gate_on: bool) -> AdmitDecision:
    """Pure gate step. ``candidate.judgement`` carries the injected judgement (may be ``None``).

    The transient judgement is always stripped from the returned fact. With the gate off the
    candidate is returned unchanged (``admit``) and ``origin`` is left as it was. With it on, a
    non-user origin or a ``model_inferred`` source is judged: a missing judgement fails closed
    (``session``, durable cleared); a secret is replaced by the redacted text (evidence cleared)
    or dropped when nothing is left; an instruction-shaped claim is flagged; a clean non-user
    origin is ``session`` (never promoted).
    """
    bare = replace(candidate, judgement=None)
    if not gate_on:
        return AdmitDecision("admit", bare)
    fact = replace(bare, origin=bare.origin if bare.origin is not None else "user")
    non_user = fact.origin != "user"
    if not non_user and fact.source != "model_inferred":
        return AdmitDecision("admit", fact)
    j = candidate.judgement or CandidateJudgement()
    if not isinstance(j.contains_secret, bool) or not isinstance(j.looks_like_instruction, bool):
        return AdmitDecision("session", replace(fact, durable=False))
    if j.contains_secret:
        redacted = (j.redacted_text or "").strip()
        if not redacted:
            return AdmitDecision("drop", fact)
        fact = replace(fact, text=redacted, evidence=None)
    if j.looks_like_instruction:
        return AdmitDecision("flag", replace(fact, flagged=True))
    if non_user:
        return AdmitDecision("session", replace(fact, durable=False))
    return AdmitDecision("admit", fact)


async def judge_candidate(candidate: Fact, judge: Judge | None) -> Fact:
    """Attach a judgement from an injected ``Judge`` to a candidate that has none.

    A candidate that already carries a judgement is returned untouched. ``None``, no judge, or a
    judge that raises leaves the judgement missing, which ``admit_candidate`` fails closed on.
    """
    if candidate.judgement is not None or judge is None:
        return candidate
    try:
        j = await judge(candidate)
    except Exception:
        return candidate
    return replace(candidate, judgement=j) if j is not None else candidate


async def admit_with_judge(candidate: Fact, gate_on: bool, judge: Judge | None = None) -> AdmitDecision:
    """``judge_candidate`` then ``admit_candidate``; the judge is only consulted when the gate is on."""
    if gate_on:
        candidate = await judge_candidate(candidate, judge)
    return admit_candidate(candidate, gate_on)


def exclude_injected_block(text: str, injected_block: str) -> str:
    """Remove verbatim copies of the injected memory block (structural, not a pattern)."""
    block = injected_block.strip()
    return text.replace(block, "") if block else text
