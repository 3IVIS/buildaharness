"""
Trajectory Supervisor — types + flag (S0 of plans/harness_trajectory_supervisor_plan.html).

A slow-loop meta-controller that intervenes *only* on the ``cannot_make_progress()``
stall edge (and, from S1, a reviewer-HIGH streak). This module holds the closed
directive enum and its payload types plus the feature flag. ``build_digest()`` lives
in ``trajectory_digest.py``; ``decide()`` (the single LLM call) is wired in S1 —
nothing in this module calls a model.

Invariants this plan introduces (enforced from the phase noted):
  INV-20  SupervisorDirective is one-shot — consumed and cleared by the loop after
          exactly one use, like ReviewerVerdict (INV-18).                    [S1]
  INV-21  The supervisor never mutates control_state / diagnostics / world_model
          beliefs / hypothesis_set directly — only strategy_state, the replan
          trigger, and escalation.                                            [S1]
  INV-22  decide() fires only on the stall edge — never on a NORMAL iteration. [S1]
  INV-23  Investigation sub-agents have no write / shell / email tools.        [S4]
  INV-24  Investigation depth is capped at 1.                                  [S4]
  INV-25  Every investigation runs under its own bounded Budget.              [S4]

S0 scope: dataclasses + ``to_dict``/``from_dict`` (enum- and payload-safe) + the
flag helper. No behaviour change anywhere — the flag is read nowhere yet.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal

if TYPE_CHECKING:
    from .trajectory_digest import TrajectoryDigest

# ── Feature flag ─────────────────────────────────────────────────────────────

_FLAG_ENV = "HARNESS_TRAJECTORY_SUPERVISOR"
_TRUTHY = frozenset({"1", "true", "yes", "on", "enabled"})


def supervisor_enabled() -> bool:
    """True iff HARNESS_TRAJECTORY_SUPERVISOR is set to a truthy value. Default OFF."""
    return os.environ.get(_FLAG_ENV, "").strip().lower() in _TRUTHY


# ── Closed action enum ───────────────────────────────────────────────────────

SupervisorAction = Literal[
    "CONTINUE",
    "REDIRECT_STRATEGY",
    "REFRAME_PLAN",
    "GATHER_EVIDENCE",
    "ASK_USER",
    "ABORT",
]

SUPERVISOR_ACTIONS: frozenset[str] = frozenset(
    ("CONTINUE", "REDIRECT_STRATEGY", "REFRAME_PLAN", "GATHER_EVIDENCE", "ASK_USER", "ABORT")
)

# Field-length caps so a directive parsed from an LLM response can never carry an
# unbounded blob into HarnessRunState.
_MAX_STR = 600
_MAX_TOOLS = 8


def _clip(text: Any, limit: int = _MAX_STR) -> str:
    s = str(text or "").strip()
    return s if len(s) <= limit else s[: limit - 1] + "…"


# ── Payload types ────────────────────────────────────────────────────────────


@dataclass
class InvestigationRequest:
    """Payload for GATHER_EVIDENCE. Wired in S4 — inert before then."""

    question: str = ""
    suggested_tools: list[str] = field(default_factory=list)
    budget: int = 5

    def to_dict(self) -> dict[str, Any]:
        return {
            "question": self.question,
            "suggested_tools": list(self.suggested_tools),
            "budget": self.budget,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any] | None) -> InvestigationRequest | None:
        if not isinstance(d, dict):
            return None
        tools = [_clip(t, 120) for t in (d.get("suggested_tools") or []) if str(t or "").strip()]
        try:
            budget = int(d.get("budget", 5))
        except (TypeError, ValueError):
            budget = 5
        return cls(
            question=_clip(d.get("question", "")),
            suggested_tools=tools[:_MAX_TOOLS],
            budget=max(0, min(budget, 50)),
        )


@dataclass
class UserQuestion:
    """Payload for ASK_USER. Wired in S3 — inert before then."""

    question: str = ""
    options: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {"question": self.question, "options": list(self.options)}

    @classmethod
    def from_dict(cls, d: dict[str, Any] | None) -> UserQuestion | None:
        if not isinstance(d, dict):
            return None
        opts = [_clip(o, 200) for o in (d.get("options") or []) if str(o or "").strip()]
        return cls(question=_clip(d.get("question", "")), options=opts[:_MAX_TOOLS])


# ── The directive ────────────────────────────────────────────────────────────


@dataclass
class SupervisorDirective:
    """The supervisor's one-shot verdict at a stall edge.

    ``from_dict()`` is deliberately total: an out-of-enum ``action``, or an action
    whose required payload is missing / malformed, degrades to ``CONTINUE`` rather
    than raising. This is the enum-safety contract from the plan's testing section.
    """

    action: SupervisorAction = "CONTINUE"
    rationale: str = ""
    strategy_hint: str | None = None
    plan_note: str | None = None
    investigation: InvestigationRequest | None = None
    question: UserQuestion | None = None

    # -- constructors -------------------------------------------------------

    @staticmethod
    def cont(rationale: str = "") -> SupervisorDirective:
        """A CONTINUE directive — the deterministic ladder proceeds unchanged."""
        return SupervisorDirective(action="CONTINUE", rationale=_clip(rationale))

    # -- serialisation ----------------------------------------------------

    def to_dict(self) -> dict[str, Any]:
        return {
            "action": self.action,
            "rationale": self.rationale,
            "strategy_hint": self.strategy_hint,
            "plan_note": self.plan_note,
            "investigation": self.investigation.to_dict() if self.investigation is not None else None,
            "question": self.question.to_dict() if self.question is not None else None,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any] | None) -> SupervisorDirective:
        if not isinstance(d, dict):
            return cls.cont()

        action = d.get("action")
        if action not in SUPERVISOR_ACTIONS:
            return cls.cont(_clip(d.get("rationale", "")))

        rationale = _clip(d.get("rationale", ""))
        strategy_hint = d.get("strategy_hint")
        strategy_hint = _clip(strategy_hint, 200) if strategy_hint else None
        plan_note = d.get("plan_note")
        plan_note = _clip(plan_note) if plan_note else None
        investigation = InvestigationRequest.from_dict(d.get("investigation"))
        question = UserQuestion.from_dict(d.get("question"))

        # Payload-shape safety: an action missing its required payload → CONTINUE.
        if action == "REDIRECT_STRATEGY" and not strategy_hint:
            return cls.cont(rationale)
        if action == "REFRAME_PLAN" and not plan_note:
            return cls.cont(rationale)
        if action == "GATHER_EVIDENCE" and (investigation is None or not investigation.question):
            return cls.cont(rationale)
        if action == "ASK_USER" and (question is None or not question.question):
            return cls.cont(rationale)

        return cls(
            action=action,  # type: ignore[arg-type]
            rationale=rationale,
            strategy_hint=strategy_hint,
            plan_note=plan_note,
            investigation=investigation if action == "GATHER_EVIDENCE" else None,
            question=question if action == "ASK_USER" else None,
        )


# ── decide() — the single LLM call (S1) ──────────────────────────────────────
#
# run_one_iteration() is a pure synchronous state transition (see loop.py's module
# doc comment), so — exactly like semantic_checks.py — this async call is made by the
# outer driver (planner_api.py's _run_planner) on the cannot_make_progress() edge and
# its result is threaded back in as run_one_iteration(supervisor_directive=...).
#
# Fail-safe: any LLM error, timeout, unparseable body, or wrong-shaped JSON resolves
# to CONTINUE — the existing deterministic ladder — never to a more aggressive action.
# This is turn-intent-classifier.ts's failSafeClassification() discipline.

_DECIDE_SYSTEM_PROMPT = (
    "You are a trajectory supervisor for a long-running autonomous agent. The agent's run has "
    "STALLED — it is not making progress. You are given a bounded JSON digest of the trajectory "
    "(the goal, how many steps were taken, why it stalled, which strategies were already tried, "
    "recurring failure classes, reopened tasks, open contradictions, and blocking unknowns). "
    "Choose the SINGLE cheapest intervention that could get it unstuck. Do not micromanage — you "
    "never make tactical decisions, only redirect. Respond with JSON only:\n"
    '{"action": <one of "CONTINUE","REDIRECT_STRATEGY","REFRAME_PLAN","GATHER_EVIDENCE",'
    '"ASK_USER","ABORT">, "rationale": string, "strategy_hint": string|null, '
    '"plan_note": string|null}\n'
    "- CONTINUE: let the agent's own deterministic recovery ladder proceed. Prefer this unless a "
    "targeted redirect is clearly better.\n"
    "- REDIRECT_STRATEGY: the agent should switch approach now; put the concrete approach in "
    '"strategy_hint" (one of DIRECT_EDIT, TRACE_EXEC, BROADER_SEARCH, REIMPLEMENT, MINIMAL_FIX).\n'
    "- REFRAME_PLAN: the whole task decomposition is wrong; describe the better framing in "
    '"plan_note".\n'
    "- GATHER_EVIDENCE / ASK_USER / ABORT: choose if genuinely warranted; the runtime may not act "
    "on these yet and will treat them as CONTINUE.\n"
    'Always include "rationale". Omit or null the fields that do not apply to your action.'
)


def _extract_json(raw: str) -> dict[str, Any] | None:
    match = re.search(r"\{.*\}", raw, re.DOTALL)
    if not match:
        return None
    try:
        parsed = json.loads(match.group())
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


async def decide_supervisor_directive(
    digest: TrajectoryDigest,
    *,
    model: str = "claude-haiku-4-5-20251001",
    temperature: float = 0.0,
) -> SupervisorDirective:
    """Ask the model for one directive given the stall digest. Never raises — any
    failure resolves to CONTINUE (the deterministic ladder)."""
    try:
        import litellm as _litellm

        response = await _litellm.acompletion(
            model=model,
            messages=[
                {"role": "system", "content": _DECIDE_SYSTEM_PROMPT},
                {"role": "user", "content": json.dumps(digest.to_dict())},
            ],
            temperature=temperature,
        )
        raw = response.choices[0].message.content or ""
    except Exception:
        return SupervisorDirective.cont("supervisor: LLM call failed")

    parsed = _extract_json(raw)
    if parsed is None:
        return SupervisorDirective.cont("supervisor: unparseable response")
    return SupervisorDirective.from_dict(parsed)
