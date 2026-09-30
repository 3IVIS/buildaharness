"""
Semantic hypotheses for the Python harness — the twin of packages/aielia/src/semantic-hypotheses.ts and of the
`semanticHypotheses` / `semanticHypothesisJudge` hooks in packages/harness/src/harness-runtime.ts.

The Python hypothesis generators are lexical: Jaccard word-overlap clusters of observations, per-belief templates,
curated failure templates, and an elimination check that looks for a shared word plus a negation word
(hypothesis.py). None of them reads what a request *means*. This module adds the semantic path:

  - `propose_competing_explanations`   one bounded LLM call: 2-4 genuinely different explanations, each with the
                                       observations it predicts and the check that would tell it apart — or none
  - `judge_hypotheses_against_evidence`  one bounded LLM call: which of them do the new observations clearly rule out
  - `add_semantic_hypotheses` / `eliminate_contradicted`  pure state updates on a HypothesisSet

Off by default (`AUDIT_SEMANTIC_HYPOTHESES`, same name and meaning as the TS flag). Like semantic_checks.py, the LLM
calls are made by whichever async driver repeatedly calls run_one_iteration() (the planner driver's `_run_planner`);
run_one_iteration() itself stays synchronous. Every call fails open: an error, an unparseable answer or an unusable
list changes nothing.

The prompts are the TS prompts, word for word.
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from typing import Any

from .hypothesis import EliminationRecord, Hypothesis, HypothesisSet
from .semantic_checks import _extract_json

SEMANTIC_SOURCE = "semantic"
MAX_HYPOTHESES = 4

_PROPOSE_PROMPT = (
    'You propose competing explanations for an underdetermined request. You are given JSON with "request" (what the '
    'user asked), "observations" (things already gathered, possibly none) and "beliefs" (what is already known). '
    'Respond with JSON only: {"hypotheses": [{"explanation": string, "predicted_observations": string[], '
    '"separating_check": string, "confidence": number}]}. If the request has one obvious answer or cause, or does not '
    'ask why something happened or which of several things is true, respond {"hypotheses": []}. Otherwise give 2 to 4 '
    'genuinely different explanations — different causes, not rewordings of one. "explanation" is one sentence. '
    '"predicted_observations" is what you would expect to see if that explanation were true. "separating_check" is the '
    'one check or observation that would tell it apart from the others. "confidence" is between 0 and 1, the values '
    "across the set should sum to about 1, and each must reflect only what the request and observations support — "
    "never favour an explanation the evidence does not favour. The message may be in any language."
)

_JUDGE_PROMPT = (
    'You decide which explanations a set of new observations rules out. You are given JSON with "hypotheses" '
    '(each {"id", "explanation", "predicted_observations"}) and "observations" (just gathered). '
    "Respond with JSON only: "
    '{"contradicted": [{"id": string, "reason": string}]}. An explanation is contradicted only when an observation '
    "clearly rules it out — it states the opposite of something the explanation requires, or shows absent "
    "something the "
    "explanation predicts. An observation that does not mention an explanation, or is compatible with it, does not "
    'contradict it. When unsure, do not list it. "reason" is one short phrase. Empty array if nothing is ruled out.'
)


def semantic_hypotheses_enabled(env: Mapping[str, str] | None = None) -> bool:
    """`AUDIT_SEMANTIC_HYPOTHESES`: default OFF; a truthy value (1/true/on/yes/enabled) turns the semantic path on."""
    source = env if env is not None else os.environ
    return str(source.get("AUDIT_SEMANTIC_HYPOTHESES", "") or "").strip().lower() in {
        "1",
        "true",
        "on",
        "yes",
        "enabled",
    }


def _as_strings(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [v.strip() for v in value if isinstance(v, str) and v.strip()]


async def _ask(system: str, payload: dict[str, Any], model: str, temperature: float) -> dict[str, Any] | None:
    try:
        import litellm as _litellm

        response = await _litellm.acompletion(
            model=model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": json.dumps(payload)},
            ],
            temperature=temperature,
        )
        raw = response.choices[0].message.content or ""
    except Exception:
        return None
    return _extract_json(raw)


async def propose_competing_explanations(
    request: str,
    observations: list[str],
    beliefs: list[str],
    model: str = "claude-haiku-4-5-20251001",
    temperature: float = 0.0,
) -> list[dict[str, Any]] | None:
    """2-4 competing explanations as dicts (explanation, predicted_observations, separating_check?, confidence?), or
    None — one explanation is not a competition, and an empty list means the request is not underdetermined."""
    parsed = await _ask(
        _PROPOSE_PROMPT,
        {"request": request, "observations": observations[-12:], "beliefs": beliefs[-12:]},
        model,
        temperature,
    )
    if parsed is None or not isinstance(parsed.get("hypotheses"), list):
        return None
    out: list[dict[str, Any]] = []
    for h in parsed["hypotheses"]:
        if not isinstance(h, dict):
            continue
        explanation = h.get("explanation")
        if not isinstance(explanation, str) or not explanation.strip():
            continue
        item: dict[str, Any] = {
            "explanation": explanation.strip(),
            "predicted_observations": _as_strings(h.get("predicted_observations")),
        }
        check = h.get("separating_check")
        if isinstance(check, str) and check.strip():
            item["separating_check"] = check.strip()
        confidence = h.get("confidence")
        if isinstance(confidence, (int, float)) and not isinstance(confidence, bool):
            item["confidence"] = float(confidence)
        out.append(item)
        if len(out) == MAX_HYPOTHESES:
            break
    return out if len(out) >= 2 else None


async def judge_hypotheses_against_evidence(
    hypotheses: list[dict[str, Any]],
    observations: list[str],
    model: str = "claude-haiku-4-5-20251001",
    temperature: float = 0.0,
) -> list[dict[str, str]] | None:
    """Which of the given hypotheses ({id, explanation, predicted_observations}) do the observations rule out?
    A list of {id, reason?} (ids the caller did not pass are dropped), or None on nothing to judge or any failure."""
    if not hypotheses or not observations:
        return None
    parsed = await _ask(
        _JUDGE_PROMPT, {"hypotheses": hypotheses, "observations": observations[-12:]}, model, temperature
    )
    if parsed is None or not isinstance(parsed.get("contradicted"), list):
        return None
    known = {h.get("id") for h in hypotheses}
    out: list[dict[str, str]] = []
    for c in parsed["contradicted"]:
        if not isinstance(c, dict) or not isinstance(c.get("id"), str) or c["id"] not in known:
            continue
        item = {"id": c["id"]}
        reason = c.get("reason")
        if isinstance(reason, str) and reason.strip():
            item["reason"] = reason.strip()
        out.append(item)
    return out


def has_semantic_hypotheses(hs: HypothesisSet) -> bool:
    return any(SEMANTIC_SOURCE in h.generation_sources for h in hs.active)


def add_semantic_hypotheses(hs: HypothesisSet, proposals: list[dict[str, Any]] | None) -> list[Hypothesis]:
    """Adds the proposals to the active set as generation source 'semantic'. Nothing to add, or already added, is a
    no-op. Ids are `sem_<n>`, counted over the semantic hypotheses already active or eliminated."""
    if not proposals or has_semantic_hypotheses(hs):
        return []
    usable = [p for p in proposals if isinstance(p.get("explanation"), str) and p["explanation"].strip()]
    if not usable:
        return []
    base = sum(1 for h in hs.active if SEMANTIC_SOURCE in h.generation_sources) + sum(
        1 for h, _ in hs.eliminated if SEMANTIC_SOURCE in h.generation_sources
    )
    created: list[Hypothesis] = []
    for i, p in enumerate(usable):
        confidence = p.get("confidence")
        valid = isinstance(confidence, (int, float)) and not isinstance(confidence, bool) and 0 <= confidence <= 1
        stated = float(confidence) if isinstance(confidence, (int, float)) and valid else None
        created.append(
            Hypothesis(
                id=f"sem_{base + i}",
                explanation=p["explanation"].strip(),
                confidence=stated if stated is not None else 1 / len(usable),
                predicted_observations=_as_strings(p.get("predicted_observations")),
                discriminating_evidence=[],
                generation_sources=[SEMANTIC_SOURCE],
                separating_check=str(p.get("separating_check") or "").strip(),
            )
        )
    hs.active.extend(created)
    return created


def eliminate_contradicted(hs: HypothesisSet, contradicted: list[dict[str, str]] | None) -> list[Hypothesis]:
    """Moves each named *semantic* hypothesis from active to eliminated (reason CONTRADICTING_EVIDENCE). Unknown ids,
    and hypotheses from any other source, are left alone."""
    removed: list[Hypothesis] = []
    for c in contradicted or []:
        target = next((h for h in hs.active if h.id == c.get("id") and SEMANTIC_SOURCE in h.generation_sources), None)
        if target is None:
            continue
        hs.active = [h for h in hs.active if h.id != target.id]
        hs.eliminated.append((target, EliminationRecord(hypothesis_id=target.id, reason="CONTRADICTING_EVIDENCE")))
        removed.append(target)
    return removed


async def seed_semantic_hypotheses(
    hs: HypothesisSet, goal: str, env: Mapping[str, str] | None = None
) -> list[Hypothesis]:
    """The async driver's first step (planner_api._run_planner): once per run, ask for competing explanations of the
    goal and add them. A no-op — and no LLM call — unless AUDIT_SEMANTIC_HYPOTHESES is on; the call itself returns
    nothing for a goal that is not underdetermined, so there is no separate gate."""
    if not semantic_hypotheses_enabled(env) or has_semantic_hypotheses(hs):
        return []
    return add_semantic_hypotheses(hs, await propose_competing_explanations(goal, [], []))


async def judge_new_observations(
    hs: HypothesisSet, observations: list[str], already_judged: int, env: Mapping[str, str] | None = None
) -> int:
    """The async driver's per-iteration step: judge the semantic hypotheses against the observations gathered since the
    last call, eliminate what they clearly rule out, and return how many observations have now been judged (pass it
    back in next time). No flag, no semantic hypotheses or nothing new: no LLM call and the count is unchanged."""
    if not semantic_hypotheses_enabled(env) or not has_semantic_hypotheses(hs):
        return already_judged
    fresh = observations[already_judged:]
    if not fresh:
        return already_judged
    live = [
        {"id": h.id, "explanation": h.explanation, "predicted_observations": h.predicted_observations}
        for h in hs.active
        if SEMANTIC_SOURCE in h.generation_sources
    ]
    eliminate_contradicted(hs, await judge_hypotheses_against_evidence(live, fresh))
    return len(observations)
