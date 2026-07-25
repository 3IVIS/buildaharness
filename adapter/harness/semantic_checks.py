"""
LLM-backed semantic escalation layered on top of the lexical checks wired into loop.py's
run_one_iteration() (Phase 5 of plans/lexical_functions_hardening_plan.html). Mirrors
packages/personal-assistant/src/contradiction-checker.ts's checkForContradictions and
failure-mode-matcher.ts's checkSemanticFailureMatch — same "one call for whatever's new, never
per-pair, fall back to the free check's own verdict on any parse failure or LLM error" shape,
using the litellm.acompletion pattern already established (synchronously) in
adapter/harness/taxonomy_classifier.py.

Not wired into loop.py's run_one_iteration() itself — that function is deliberately kept
synchronous (see loop.py's module doc comment). The caller is whichever outer async driver
repeatedly calls run_one_iteration() (adapter/planner_api.py's `_run_planner`); see that module for
the actual gating (only called when the lexical check already found nothing, with a delta guard so
an unchanged belief/symptom set isn't re-asked every iteration).

Deliberately written against Python's own FailurePattern shape (name/description/
required_conditions), not TS's FailureModeEntry (id/failure_class/symptoms/description) — the two
have structurally diverged (see this plan's Decision 8, Finding C) and reconciling them is a
separate decision; this writes the semantic matcher against whichever shape Python's
FailureModeLibrary actually uses today.
"""

from __future__ import annotations

import json
import re
from typing import Any

_CONTRADICTION_SYSTEM_PROMPT = (
    "You check a set of beliefs for genuine contradictions — statements that cannot both be true "
    "at the same time (e.g. two different home cities, conflicting preferences, opposite factual "
    "claims). Do not flag beliefs that are merely about different topics, or that could both be "
    "true. Do not flag a new belief that explicitly updates or corrects an existing one (e.g. "
    '"Actually, I\'m now a senior analyst" superseding "I\'m an analyst") — that is a stated change '
    "over time, not two simultaneously-held conflicting claims. You are given \"new_beliefs\" (just "
    'learned) and "existing_beliefs" (already known and already mutually consistent with each '
    "other) as JSON, each entry {\"id\": string, \"statement\": string}. Check new_beliefs against "
    "existing_beliefs, and against each other. The message may be in any language — judge the "
    "actual meaning, never assume English. Respond with JSON only: {\"contradictions\": "
    '[{"belief_ids": [id, id, ...], "description": string}]}. "description" describes what the '
    "beliefs say, never their ids. Empty array if none."
)

_FAILURE_MATCH_SYSTEM_PROMPT = (
    "You match a set of observed symptoms against a curated library of known failure patterns — "
    'not by exact wording, but by meaning. You are given "symptoms" (free-text observations) and '
    '"patterns" (each with a name, description, and required_conditions — short phrases that '
    "characterize the pattern) as JSON. If one pattern genuinely matches, respond with JSON only: "
    '{"matched": true, "pattern_name": string, "confidence": number between 0 and 1}. If none '
    'genuinely match, respond {"matched": false}. Do not force a match onto an unrelated pattern.'
)


def _extract_json(raw: str) -> dict[str, Any] | None:
    match = re.search(r"\{.*\}", raw, re.DOTALL)
    if not match:
        return None
    try:
        return json.loads(match.group())
    except json.JSONDecodeError:
        return None


async def semantic_contradiction_check(
    new_beliefs: list[dict[str, str]],
    existing_beliefs: list[dict[str, str]],
    model: str = "claude-haiku-4-5-20251001",
    temperature: float = 0.0,
) -> list[dict[str, Any]]:
    """Returns a list of {"belief_ids": [...], "description": ...} dicts, each suitable for
    contradiction.py's record_external_contradiction(belief_ids=..., description=...). Empty list
    (never raises) on no new beliefs, no contradictions found, or any LLM/parse failure.
    """
    if not new_beliefs:
        return []

    try:
        import litellm as _litellm

        response = await _litellm.acompletion(
            model=model,
            messages=[
                {"role": "system", "content": _CONTRADICTION_SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": json.dumps({"new_beliefs": new_beliefs, "existing_beliefs": existing_beliefs}),
                },
            ],
            temperature=temperature,
        )
        raw = response.choices[0].message.content or ""
    except Exception:
        return []

    parsed = _extract_json(raw)
    if parsed is None:
        return []

    contradictions = parsed.get("contradictions")
    if not isinstance(contradictions, list):
        return []

    results: list[dict[str, Any]] = []
    for c in contradictions:
        if not isinstance(c, dict):
            continue
        belief_ids = c.get("belief_ids")
        description = c.get("description")
        if not isinstance(belief_ids, list) or not all(isinstance(b, str) for b in belief_ids):
            continue
        if not isinstance(description, str) or not description:
            continue
        results.append({"belief_ids": belief_ids, "description": description})
    return results


async def semantic_failure_match(
    symptoms: list[str],
    patterns: list[Any],
    model: str = "claude-haiku-4-5-20251001",
    temperature: float = 0.0,
) -> dict[str, Any] | None:
    """`patterns` is FailureModeLibrary.patterns (FailurePattern objects). Returns
    {"pattern_name": str, "confidence": float} on a genuine match, else None (never raises) —
    including on empty symptoms/patterns, no match found, or any LLM/parse failure.
    """
    if not symptoms or not patterns:
        return None

    pattern_payload = [
        {"name": p.name, "description": p.description, "required_conditions": p.required_conditions} for p in patterns
    ]
    valid_names = {p.name for p in patterns}

    try:
        import litellm as _litellm

        response = await _litellm.acompletion(
            model=model,
            messages=[
                {"role": "system", "content": _FAILURE_MATCH_SYSTEM_PROMPT},
                {"role": "user", "content": json.dumps({"symptoms": symptoms, "patterns": pattern_payload})},
            ],
            temperature=temperature,
        )
        raw = response.choices[0].message.content or ""
    except Exception:
        return None

    parsed = _extract_json(raw)
    if parsed is None:
        return None

    if parsed.get("matched") is not True:
        return None
    pattern_name = parsed.get("pattern_name")
    if not isinstance(pattern_name, str) or pattern_name not in valid_names:
        return None
    confidence = parsed.get("confidence")
    confidence = min(1.0, max(0.0, confidence)) if isinstance(confidence, (int, float)) else 0.5
    return {"pattern_name": pattern_name, "confidence": confidence}
