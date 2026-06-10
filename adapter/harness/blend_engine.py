"""
G-1 — StrategyBlendEngine

Configurable, momentum-bounded strategy weight distribution engine.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable


@dataclass
class BlendRule:
    condition: Callable[[dict], bool]
    adjustments: dict[str, float]
    redistribute_to: list[str] | None
    style_override: str | None = None


def normalize_blend(blend: dict[str, float]) -> dict[str, float]:
    floored = {k: max(0.0, v) for k, v in blend.items()}
    total = sum(floored.values())
    if total == 0:
        return blend
    scale = 100.0 / total
    return {k: v * scale for k, v in floored.items()}


def make_blend_adjuster(
    rules: list[BlendRule],
    blend_key: str = "strategy_blend",
    momentum_cap: float = 10.0,
) -> Callable[[dict], dict]:
    def adjuster(state: dict) -> dict:
        blend = state.get(blend_key)
        if not blend:
            return state

        original = dict(blend)
        current = dict(blend)
        fired_rules: list[BlendRule] = []

        for rule in rules:
            if not rule.condition(state):
                continue

            fired_rules.append(rule)
            freed = 0.0

            for key, delta in rule.adjustments.items():
                if key not in current:
                    continue
                old_val = current[key]
                new_val = max(0.0, old_val + delta)
                freed += old_val - new_val  # actual reduction (0 for positive deltas)
                current[key] = new_val

            if freed > 0 and rule.redistribute_to:
                targets = [k for k in rule.redistribute_to if k in current]
                total_target = sum(current[k] for k in targets)
                if total_target > 0:
                    for k in targets:
                        current[k] += freed * (current[k] / total_target)

        # Momentum cap: clamp total per-key change vs original to ±momentum_cap
        for key in current:
            if key not in original:
                continue
            delta = current[key] - original[key]
            if abs(delta) > momentum_cap:
                current[key] = original[key] + (momentum_cap if delta > 0 else -momentum_cap)
                current[key] = max(0.0, current[key])

        current = normalize_blend(current)

        result = {**state, blend_key: current}

        for rule in fired_rules:
            if rule.style_override is not None:
                result["style_override"] = rule.style_override

        return result

    return adjuster
