"""
Tests for adapter/harness/script_utils.py and adapter/harness/lexical_patterns.py — mirrors
packages/harness/src/lexical/script-utils.test.ts and patterns.test.ts case-for-case.

Run:        pytest adapter/tests/test_script_utils.py -v
"""

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.lexical_patterns import get_negation_pairs, get_review_negation_triggers
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
    assert polarity_words == ["not", "absent", "no"]


def test_get_review_negation_triggers_matches_ts_fixture():
    triggers, stopwords = get_review_negation_triggers()
    assert "not " in triggers
    assert "no longer " in triggers
    assert "and" in stopwords
