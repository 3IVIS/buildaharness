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
    evidence_negation_words: set[str]
    constraint_negation_words: set[str]


def _load_negation() -> NegationPatterns:
    data = json.loads((_PATTERNS_DIR / "negation.json").read_text(encoding="utf-8"))
    merged: NegationPatterns = {
        "stopwords": set(),
        "pairs": [],
        "polarity_words": [],
        "review_stopwords": set(),
        "review_triggers": [],
        "evidence_negation_words": set(),
        "constraint_negation_words": set(),
    }
    for lang in data.values():
        merged["stopwords"].update(lang["stopwords"])
        merged["pairs"].extend((pair[0], pair[1]) for pair in lang["pairs"])
        merged["polarity_words"].extend(lang["polarityWords"])
        merged["review_stopwords"].update(lang["reviewStopwords"])
        merged["review_triggers"].extend(lang["reviewTriggers"])
        merged["evidence_negation_words"].update(lang["evidenceNegationWords"])
        merged["constraint_negation_words"].update(lang["constraintNegationWords"])
    return merged


_negation = _load_negation()


def get_negation_pairs() -> tuple[list[tuple[str, str]], frozenset[str], list[str]]:
    """`_NEGATION_PAIRS` + stopwords + polarity words — matches contradiction.py's `_statements_opposed`."""
    return _negation["pairs"], frozenset(_negation["stopwords"]), _negation["polarity_words"]


def get_review_negation_triggers() -> tuple[list[str], frozenset[str]]:
    """`_NEGATION_TRIGGERS` + stopwords — matches review_gate.py's `_is_negation`."""
    return _negation["review_triggers"], frozenset(_negation["review_stopwords"])


def get_evidence_negation_words() -> frozenset[str]:
    """Single-word negation markers used to check whether HIGH-reliability evidence contradicts a
    belief/prediction (shared-vocabulary-plus-negation-word gate) — matches reviewer.py's
    `reviewer_lens` gap-finding check and hypothesis.py's `check_contradicting_evidence`. Both
    previously hardcoded their own copy of this set (drifted: reviewer.py's was missing
    "unavailable"); this is the single source both now read."""
    return frozenset(_negation["evidence_negation_words"])


def get_constraint_negation_words() -> frozenset[str]:
    """Negation markers used to detect whether a caller_specific_constraint is negatively phrased
    ("must not reference X", "without Y") — matches output_contract.py's
    `check_caller_specific_constraints`, mirrored in packages/harness/src/nodes/output-validation.ts's
    `outputValidation`. Both previously hardcoded their own identical copy of this set; this is the
    single source both now read."""
    return frozenset(_negation["constraint_negation_words"])


class GranularityMarkers(TypedDict):
    statement_level_markers: list[str]
    function_level_markers: list[str]


def _load_granularity() -> GranularityMarkers:
    data = json.loads((_PATTERNS_DIR / "granularity-markers.json").read_text(encoding="utf-8"))
    merged: GranularityMarkers = {"statement_level_markers": [], "function_level_markers": []}
    for lang in data.values():
        merged["statement_level_markers"].extend(lang["statementLevelMarkers"])
        merged["function_level_markers"].extend(lang["functionLevelMarkers"])
    return merged


_granularity = _load_granularity()


def get_granularity_markers() -> tuple[list[str], list[str]]:
    """Code-granularity keyword markers — merges what used to be two separate, overlapping-but-not-
    identical lists: contradiction.py's `line_level_keywords` (used by
    `detect_abstraction_contradictions`'s LOW-severity advisory check) and task_graph.py's
    `statement_markers`/`function_markers` (used by `estimate_world_model_granularity`'s 0/1/2
    module/function/statement classification). Mirrored in
    packages/harness/src/lexical/patterns.ts, read by detect-contradictions.ts and
    update-diagnostics.ts. Returns (statement_level_markers, function_level_markers)."""
    return _granularity["statement_level_markers"], _granularity["function_level_markers"]
