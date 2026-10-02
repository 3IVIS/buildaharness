"""Budgeted, priority-ranked facts block (M1 ``renderFactsBlock``). Pure and deterministic.

Ranking is structural: tier priority, then newest statement, then most recently injected, then
later position. There is no query-relevance scoring (D2). Lengths are measured in UTF-16 code
units so the budget decision is identical to the TS implementation for any input.
"""

from __future__ import annotations

from dataclasses import dataclass

from ._core_generated import BUDGET_HEADER, DEFAULT_MEMORY_BUDGET_CHARS, UNCONFIRMED_SUFFIX
from .model import Fact
from .tiers import render_priority


def js_len(s: str) -> int:
    """Length in UTF-16 code units (what ``String.length`` returns in TS)."""
    return len(s.encode("utf-16-le")) // 2


@dataclass(frozen=True)
class RenderedFacts:
    block: str
    shown: list[Fact]
    dropped_count: int


def is_unconfirmed(f: Fact) -> bool:
    return f.source == "model_inferred" and f.confidence in ("medium", "low")


def fact_line(f: Fact) -> str:
    return f"- {f.text}{UNCONFIRMED_SUFFIX if is_unconfirmed(f) else ''}"


def merge_facts(durable: list[Fact], session: list[Fact]) -> list[Fact]:
    """Durable first, then session facts whose text is not already among the durable ones."""
    texts = {f.text for f in durable}
    return [*durable, *(f for f in session if f.text not in texts)]


def in_scope(facts: list[Fact], project: str | None) -> list[Fact]:
    """Facts with no project, or the current project."""
    return [f for f in facts if not f.project or f.project == project]


def render_facts_block(facts: list[Fact], budget_chars: int = DEFAULT_MEMORY_BUDGET_CHARS) -> RenderedFacts:
    """Render ``facts`` (already scope-filtered) under ``budget_chars``.

    Retired facts are excluded first. A line that does not fit is skipped and a later, shorter
    one may still fit. ``dropped_count`` is the number of live facts not shown.
    """
    live = [f for f in facts if not f.retired_at]
    order = list(range(len(live)))
    # Sort keys, least significant first (Python's sort is stable): position desc, lastInjectedAt desc,
    # extractedAt desc, priority asc.
    order.sort(key=lambda i: i, reverse=True)
    order.sort(key=lambda i: live[i].last_injected_at or "", reverse=True)
    order.sort(key=lambda i: live[i].extracted_at, reverse=True)
    order.sort(key=lambda i: render_priority(live[i]))
    used = js_len(BUDGET_HEADER)
    shown: list[Fact] = []
    lines: list[str] = []
    for i in order:
        f = live[i]
        line = fact_line(f)
        cost = js_len(line) + (1 if lines else 0)
        if used + cost > budget_chars:
            continue
        lines.append(line)
        shown.append(f)
        used += cost
    block = f"{BUDGET_HEADER}{chr(10).join(lines)}" if lines else ""
    return RenderedFacts(block=block, shown=shown, dropped_count=len(live) - len(shown))
