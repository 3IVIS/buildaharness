"""
Script-aware text utilities shared by every lexical (non-LLM) check in the Python harness
implementation — mirrors packages/harness/src/lexical/script-utils.ts function-for-function.

`.split()`-based word counting/tokenization silently breaks on CJK text, which has no
inter-word whitespace — an entire Chinese sentence splits into exactly one "word". These
utilities give every consumer a tokenization that's meaningful for both: CJK spans are split
per-character (a cheap, no-dependency approximation of real segmentation), non-CJK spans keep
ordinary whitespace-based word splitting.
"""

from __future__ import annotations

import re

# CJK Unified Ideographs, Extension A, and Compatibility Ideographs — matches
# script-utils.ts's CJK_CHAR range.
_CJK_CHAR = re.compile(r"[㐀-䶿一-鿿豈-﫿]")
# Unambiguous CJK clause/sentence boundaries (period, exclamation, question mark, semicolon —
# both fullwidth and halfwidth forms). Deliberately excludes the CJK comma (，) and enumeration
# comma (、) — see script-utils.ts's own comment for why.
_CJK_CLAUSE_PUNCTUATION = re.compile(r"[。！？；!?;]")


def contains_cjk(text: str) -> bool:
    return bool(_CJK_CHAR.search(text))


def tokenize(text: str) -> list[str]:
    """Splits `text` into tokens: each CJK character becomes its own token, everything else is
    whitespace-split as usual. For text with no CJK characters at all, this is identical to
    `text.split()` — the existing behavior every consumer being migrated onto this module
    already relies on.
    """
    tokens: list[str] = []
    buffer = ""
    for ch in text:
        if _CJK_CHAR.match(ch):
            if buffer:
                tokens.extend(buffer.split())
                buffer = ""
            tokens.append(ch)
        else:
            buffer += ch
    if buffer:
        tokens.extend(buffer.split())
    return tokens


def token_count(text: str) -> int:
    return len(tokenize(text))


def shared_tokens(a: str, b: str, stopwords: frozenset[str] = frozenset()) -> list[str]:
    """Case-insensitive shared-token overlap between two strings, minus `stopwords`."""
    set_a = {t.lower() for t in tokenize(a) if t.lower() not in stopwords}
    set_b = {t.lower() for t in tokenize(b) if t.lower() not in stopwords}
    return list(set_a & set_b)


def split_clauses(text: str, extra_boundary: re.Pattern[str] | None = None) -> list[str]:
    """Splits `text` into clauses on CJK sentence-ending punctuation and, additionally, on
    `extra_boundary` if supplied, applied within each CJK-punctuation-delimited chunk.
    """
    chunks = _CJK_CLAUSE_PUNCTUATION.split(text)
    result: list[str] = []
    for chunk in chunks:
        if extra_boundary is not None:
            result.extend(extra_boundary.split(chunk))
        else:
            result.append(chunk)
    return [s.strip() for s in result if s.strip()]
