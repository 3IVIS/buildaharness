"""
`HARNESS_LEXICAL_OFF` for the Python harness — switches off the lexical checks (word-overlap and word-list
passes) so a semantic layer sitting on top of each one runs alone. Mirrors
packages/harness/src/lexical/lexical-off.ts, which is where the switch started; the Python harness had none.

    HARNESS_LEXICAL_OFF=all                      every check below
    HARNESS_LEXICAL_OFF=hypothesis-clustering,…  individual checks (comma list)

Unset / empty (the default) is today's behaviour, byte for byte. Read at call time, never at import time.
With a check off and no semantic hook wired by the host, that step simply produces nothing — nothing replaces it.

  - hypothesis-clustering            hypothesis.py — Jaccard word-overlap clustering of observations into
                                     "symptom" hypotheses, and the Jaccard dedupe that merges near-identical ones
  - hypothesis-negation-elimination  hypothesis.py — `check_contradicting_evidence`: a HIGH-reliability observation
                                     that shares a word with a prediction and contains a negation word

Only the hypothesis checks are covered so far; the negation-pair, review-negation, failure-match and
criterion checks the TS switch names are still always on here.
"""

from __future__ import annotations

import os
from collections.abc import Mapping

HARNESS_LEXICAL_CHECKS: tuple[str, ...] = ("hypothesis-clustering", "hypothesis-negation-elimination")


def resolve_harness_lexical_off(env: Mapping[str, str] | None = None) -> frozenset[str]:
    source = env if env is not None else os.environ
    raw = str(source.get("HARNESS_LEXICAL_OFF", "") or "").strip().lower()
    if not raw:
        return frozenset()
    off: set[str] = set()
    for token in raw.split(","):
        name = token.strip()
        if name == "all":
            off.update(HARNESS_LEXICAL_CHECKS)
        elif name in HARNESS_LEXICAL_CHECKS:
            off.add(name)
    return frozenset(off)


def harness_lexical_active(check: str, env: Mapping[str, str] | None = None) -> bool:
    """True unless this check is switched off."""
    source = env if env is not None else os.environ
    if not source.get("HARNESS_LEXICAL_OFF"):
        return True  # fast path: nothing set
    return check not in resolve_harness_lexical_off(source)
