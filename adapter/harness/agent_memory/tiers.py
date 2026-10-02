"""Structural tier classification (the Python rule from the M8 scoping addendum, section 2).

The ordered rule list is contract data (``TIER_RULE_ORDER`` in ``_core_generated``) evaluated
first-match by a tiny condition interpreter, so a change to the rule is one edit in the JSON.
Conditions only compare the fact's own ``origin``/``source``/``durable``/``confidence``/
``category`` bits: there is no regex, keyword or text inspection anywhere here (D2).
``procedural`` and ``commitment`` are never returned: they belong to other stores.
"""

from __future__ import annotations

from typing import Any

from ._core_generated import SESSION_PRIORITY, TIER_PRIORITY, TIER_RULE_ORDER, TIER_RULES
from .model import Fact


def _matches(cond: dict[str, Any], fact: Fact) -> bool:
    if "always" in cond:
        return bool(cond["always"])
    if "all" in cond:
        return all(_matches(c, fact) for c in cond["all"])
    if "not" in cond:
        return not _matches(cond["not"], fact)
    value = getattr(fact, cond["field"])
    if "present" in cond:
        return (value is not None) == cond["present"]
    if "eq" in cond:
        return value == cond["eq"]
    if "neq" in cond:
        return value != cond["neq"]
    raise ValueError(f"unsupported tier condition: {cond!r}")


def tier_rule_for_fact(fact: Fact) -> dict[str, Any]:
    """The first ``TIER_RULE_ORDER`` entry that matches ``fact`` (the last rule always matches)."""
    for rule in TIER_RULE_ORDER:
        if _matches(rule["when"], fact):
            return rule
    raise AssertionError("tier rules must end with an always-matching rule")


def tier_for_fact(fact: Fact) -> str:
    """The memory tier of ``fact``: episodic | semantic | identity | preference (total and pure)."""
    return str(tier_rule_for_fact(fact)["tier"])


def is_knowledge_tier(tier: str) -> bool:
    """Whether contradiction detection (and so "Knowledge" status) applies to ``tier``."""
    return bool(TIER_RULES[tier]["contradiction_checked"])


def render_priority(fact: Fact) -> int:
    """Budgeted-render priority: any non-durable fact is ``SESSION_PRIORITY``; otherwise by tier."""
    if not fact.durable:
        return SESSION_PRIORITY
    return TIER_PRIORITY.get(tier_for_fact(fact), 1)
