"""
The switch for the Python harness's own lexical checks (keyword / substring / token-overlap / phrase-list
passes over natural-language text). Mirrors packages/harness/src/lexical/lexical-off.ts. **Every check is
OFF by default**; with a check off and no semantic replacement, that step simply reports nothing.

    HARNESS_LEXICAL_MODE=enabled                 every check below back on (the pre-2026-09-30 behaviour)
    HARNESS_LEXICAL_MODE=disabled                every check off (the default; same as unset)
    HARNESS_LEXICAL_ON=negation-pairs,…          turn only these on (comma list, or `all`)
    HARNESS_LEXICAL_OFF=negation-pairs,…         turn only these off (comma list, or `all`)

Resolution per check: named in HARNESS_LEXICAL_OFF → off; else named in HARNESS_LEXICAL_ON → on; else the
mode. Read at call time, never at import time. Names shared with the TS twin mean the same check.

  - negation-pairs                   contradiction.py — the keyword-negation matcher (pairwise and set-level)
  - granularity-markers              contradiction.py abstraction contradictions, task_graph.py granularity
  - review-negation                  review_gate.py — `_is_negation`
  - review-phrases                   review_gate.py — "remove <field>" and "syntax error" phrases
  - failure-exact-match              failure_modes.py — required/excluded condition substring matching
  - system-error-symptoms            execution.py — error phrases mapped onto library symptom text
  - criterion-substring              reviewer.py — implementer lens: criterion text inside a belief statement
  - criterion-proximity              reviewer.py — adversarial seeding: criterion text inside a belief statement
  - criterion-scope                  constraint_propagation.py / caller_state.py — criterion/task/belief overlap
  - constraint-negation              output_contract.py — the lexical caller-constraint check
  - preference-patterns              preference_extractor.py — phrase lists
  - source-dedupe                    multi_source_reducer.py — word-overlap near-duplicate detection

Not covered, on purpose (they match identifiers, not prose): output_contract.py's `required:` DSL and the
reviewer pass's task-id-in-finding check.
"""

from __future__ import annotations

import os
from collections.abc import Mapping

HARNESS_LEXICAL_CHECKS: tuple[str, ...] = (
    "negation-pairs",
    "granularity-markers",
    "review-negation",
    "review-phrases",
    "failure-exact-match",
    "system-error-symptoms",
    "criterion-substring",
    "criterion-proximity",
    "criterion-scope",
    "constraint-negation",
    "preference-patterns",
    "source-dedupe",
)

DEFAULT_HARNESS_LEXICAL_MODE = "disabled"


def _parse(raw: str | None) -> set[str]:
    out: set[str] = set()
    for token in str(raw or "").lower().split(","):
        name = token.strip()
        if name == "all":
            out.update(HARNESS_LEXICAL_CHECKS)
        elif name in HARNESS_LEXICAL_CHECKS:
            out.add(name)
    return out


def resolve_harness_lexical_mode(env: Mapping[str, str] | None = None) -> str:
    source = env if env is not None else os.environ
    raw = str(source.get("HARNESS_LEXICAL_MODE", "") or "").strip().lower()
    return raw if raw in ("enabled", "disabled") else DEFAULT_HARNESS_LEXICAL_MODE


def resolve_harness_lexical_off(env: Mapping[str, str] | None = None) -> frozenset[str]:
    """Every check currently switched off."""
    source = env if env is not None else os.environ
    off = _parse(source.get("HARNESS_LEXICAL_OFF"))
    on = _parse(source.get("HARNESS_LEXICAL_ON"))
    if resolve_harness_lexical_mode(source) != "enabled":
        off.update(c for c in HARNESS_LEXICAL_CHECKS if c not in on)
    return frozenset(off)


def harness_lexical_active(check: str, env: Mapping[str, str] | None = None) -> bool:
    """True only if this check is switched on."""
    return check not in resolve_harness_lexical_off(env)
