"""
G-2 — TurnContextBootstrap

Configurable turn-state initialiser for multi-turn conversational agents.
Handles source-path field mapping, turn-1-only seeding, resource budget
tracking, and model skeleton initialisation.
"""

from __future__ import annotations

import copy
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any


@dataclass
class SessionField:
    key: str
    default: Any
    source_path: str | None = None
    init_once: bool = False


@dataclass
class ResourceBudget:
    time_limit_seconds: int
    token_budget: int
    budget_key: str = "resource_budget"
    turn_key: str = "turn_number"


def _resolve_dot_path(state: dict, path: str) -> tuple[bool, Any]:
    """Traverse a dot-separated path in state. Returns (found, value)."""
    current = state
    for part in path.split("."):
        if not isinstance(current, dict) or part not in current:
            return False, None
        current = current[part]
        if current is None:
            return True, None
    return True, current


def make_turn_initializer(
    fields: list[SessionField],
    resource_budget: ResourceBudget | None = None,
    empty_model_key: str | None = None,
    empty_model_template: dict | None = None,
) -> Callable[[dict], dict]:
    turn_key = resource_budget.turn_key if resource_budget is not None else "turn_number"

    def initializer(state: dict) -> dict:
        result = {**state}

        raw_turn = result.get(turn_key)
        is_turn_one = raw_turn is None or raw_turn <= 1

        # Steps 1 & 2: SessionFields
        for f in fields:
            if f.source_path is not None:
                if f.init_once and not is_turn_one:
                    continue
                found, value = _resolve_dot_path(result, f.source_path)
                if not found or value is None:
                    value = f.default
                result[f.key] = value
            else:
                # Write default only if key is absent (init_once has no effect here)
                if f.key not in result:
                    result[f.key] = f.default

        # Step 3: Resource budget
        if resource_budget is not None:
            budget_key = resource_budget.budget_key
            now = datetime.now(UTC)

            if is_turn_one:
                result[budget_key] = {
                    "time_limit_seconds": resource_budget.time_limit_seconds,
                    "token_budget": resource_budget.token_budget,
                    "elapsed_seconds": 0,
                    "tokens_used": 0,
                    "started_at": now,
                }
            else:
                existing = result.get(budget_key, {})
                started_at = existing.get("started_at")
                elapsed = (now - started_at).total_seconds() if started_at is not None else 0
                result[budget_key] = {**existing, "elapsed_seconds": elapsed}

        # Step 4: Empty model seeding
        if empty_model_key is not None and not result.get(empty_model_key):
            template = empty_model_template if empty_model_template is not None else {}
            result[empty_model_key] = copy.deepcopy(template)

        return result

    return initializer
