"""
Tests for adapter/harness/script_utils.py and adapter/harness/lexical_patterns.py — mirrors
packages/harness/src/lexical/script-utils.test.ts and patterns.test.ts case-for-case.

Run:        pytest adapter/tests/test_script_utils.py -v
"""

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.lexical_patterns import (
    get_constraint_negation_words,
    get_evidence_negation_words,
    get_granularity_markers,
    get_negation_pairs,
    get_review_negation_triggers,
)
from harness.script_utils import contains_cjk, shared_tokens, split_clauses, token_count, tokenize


def test_contains_cjk_detects_cjk_characters():
    assert contains_cjk("你好") is True
    assert contains_cjk("hello 你好") is True


def test_contains_cjk_false_for_latin_punctuation_or_empty():
    assert contains_cjk("hello world") is False
    assert contains_cjk("...") is False
    assert contains_cjk("") is False


def test_tokenize_matches_plain_split_for_english():
    assert tokenize("the login tests passed") == ["the", "login", "tests", "passed"]
    assert token_count("the login tests passed") == 4


def test_tokenize_splits_each_cjk_character():
    assert tokenize("你好世界") == ["你", "好", "世", "界"]
    assert token_count("你好世界") == 4


def test_tokenize_handles_mixed_english_cjk():
    assert tokenize("hello 你好 world") == ["hello", "你", "好", "world"]


def test_tokenize_ignores_extra_whitespace():
    assert tokenize("  the   tests  ") == ["the", "tests"]


def test_shared_tokens_finds_overlap_minus_stopwords():
    stopwords = frozenset({"the", "a", "an"})
    assert shared_tokens("The login tests passed", "the login build failed", stopwords) == ["login"]


def test_shared_tokens_no_overlap_for_unrelated_statements():
    stopwords = frozenset({"the", "a", "an"})
    assert shared_tokens("the login tests passed", "the payment build failed", stopwords) == []


def test_shared_tokens_works_on_cjk_via_character_tokens():
    result = set(shared_tokens("登录测试通过", "登录测试失败"))
    assert {"登", "录", "测", "试"}.issubset(result)


def test_split_clauses_reduces_to_extra_boundary_split_without_cjk_punctuation():
    assert split_clauses("a, and b", re.compile(r",\s*(?:and)\b", re.IGNORECASE)) == ["a", "b"]


def test_split_clauses_splits_on_cjk_sentence_punctuation():
    assert split_clauses("第一句。第二句!第三句?") == ["第一句", "第二句", "第三句"]


def test_split_clauses_does_not_split_on_cjk_commas():
    assert split_clauses("一，二、三") == ["一，二、三"]


def test_get_negation_pairs_matches_ts_fixture():
    pairs, stopwords, polarity_words = get_negation_pairs()
    assert ("passed", "failed") in pairs
    assert ("online", "offline") in pairs
    assert "the" in stopwords
    # Containment, not exact equality — merges every language present (see mergeAcrossLanguages'
    # doc comment); pinning this to the English-only list would break the moment any other
    # language's content (e.g. "zh") is added, which is exactly what happened here.
    for word in ("not", "absent", "no"):
        assert word in polarity_words


def test_get_review_negation_triggers_matches_ts_fixture():
    triggers, stopwords = get_review_negation_triggers()
    assert "not " in triggers
    assert "no longer " in triggers
    assert "and" in stopwords


def test_get_evidence_negation_words_matches_ts_fixture():
    # 8-word union of reviewer.py's and hypothesis.py's formerly-separate, drifted sets — see
    # get_evidence_negation_words()'s doc comment. "unavailable" is the word reviewer.py's own
    # copy used to be missing relative to hypothesis.py's. Superset check, not exact equality —
    # merges every language present, so this must not break when another language (e.g. "zh")
    # adds its own words to the same field.
    words = get_evidence_negation_words()
    assert words.issuperset({"no", "not", "absent", "missing", "failed", "none", "error", "unavailable"})


def test_get_constraint_negation_words_matches_ts_fixture():
    # Shared source for output_contract.py's check_caller_specific_constraints and
    # output-validation.ts's outputValidation — previously two byte-identical hardcoded copies.
    # Superset check, not exact equality — see test_get_evidence_negation_words_matches_ts_fixture.
    words = get_constraint_negation_words()
    assert words.issuperset({"not", "never", "no", "without", "exclude", "must not"})


def test_get_granularity_markers_matches_ts_fixture():
    # Merges what used to be two separate, overlapping-but-not-identical lists: contradiction.py's
    # line_level_keywords and task_graph.py's statement_markers/function_markers.
    statement_markers, function_markers = get_granularity_markers()
    expected_statement_markers = (
        "line ",
        "line\t",
        ":line",
        " ln ",
        " l",
        "column ",
        "char ",
        "line:",
        "statement",
        "expression",
        "lineno",
    )
    for marker in expected_statement_markers:
        assert marker in statement_markers
    for marker in ("function", "method", "def ", "procedure", "()"):
        assert marker in function_markers
