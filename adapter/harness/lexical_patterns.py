"""
Loads adapter/harness's own lexical pattern data (adapter/harness/lexical_patterns/*.json) — the
canonical-for-Python, language-keyed source for negation-pair/trigger matching used by
contradiction.py and review_gate.py.

Kept as a byte-for-byte-checked mirror of packages/harness/src/lexical/patterns/*.json (see
scripts/check-lexical-patterns-sync.mjs) rather than a cross-package file read, matching this
repo's existing plan-templates convention (adapter/agents/planner/data/plan_templates/ vs.
packages/personal-assistant/src/plan-templates/data/, checked by
scripts/check-plan-templates-sync.mjs) — Python and the TS packages shouldn't reach into each
other's source trees at runtime.

Only "en" exists today; adding another language is a pure data addition to the JSON files, not a
code change here.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import TypedDict

_PATTERNS_DIR = Path(__file__).parent / "lexical_patterns"


class NegationPatterns(TypedDict):
    stopwords: set[str]
    pairs: list[tuple[str, str]]
    polarity_words: list[str]
    review_stopwords: set[str]
    review_triggers: list[str]


def _load_negation() -> NegationPatterns:
    data = json.loads((_PATTERNS_DIR / "negation.json").read_text(encoding="utf-8"))
    merged: NegationPatterns = {
        "stopwords": set(),
        "pairs": [],
        "polarity_words": [],
        "review_stopwords": set(),
        "review_triggers": [],
    }
    for lang in data.values():
        merged["stopwords"].update(lang["stopwords"])
        merged["pairs"].extend((pair[0], pair[1]) for pair in lang["pairs"])
        merged["polarity_words"].extend(lang["polarityWords"])
        merged["review_stopwords"].update(lang["reviewStopwords"])
        merged["review_triggers"].extend(lang["reviewTriggers"])
    return merged


_negation = _load_negation()


def get_negation_pairs() -> tuple[list[tuple[str, str]], frozenset[str], list[str]]:
    """`_NEGATION_PAIRS` + stopwords + polarity words — matches contradiction.py's `_statements_opposed`."""
    return _negation["pairs"], frozenset(_negation["stopwords"]), _negation["polarity_words"]


def get_review_negation_triggers() -> tuple[list[str], frozenset[str]]:
    """`_NEGATION_TRIGGERS` + stopwords — matches review_gate.py's `_is_negation`."""
    return _negation["review_triggers"], frozenset(_negation["review_stopwords"])
