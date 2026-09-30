"""
World model integration operations — P2.1.

Twin of packages/harness/src/nodes/update-world-model.ts. `update_world_model()` folds one piece of Evidence into
the world model: OBSERVATION / SYSTEM_ERROR evidence becomes an observation (and marks its region complete unless
`prune`), INFERENCE evidence becomes a belief (which requires an explicit `derived_from` chain — INV-01). It then
refreshes the belief-health sub-dimensions and bumps the generation.
"""

from __future__ import annotations

from typing import Any

from .diagnostics import Diagnostics, normalise
from .evidence import Evidence
from .world_model import Belief, Observation, WorldModel

_RELIABILITY_TO_FLOAT: dict[str, float] = {"HIGH": 1.0, "MEDIUM": 0.5}


def _reliability_to_float(reliability: str) -> float:
    return _RELIABILITY_TO_FLOAT.get(reliability, 0.0)


def _parse_iso(value: str) -> Any:
    from datetime import UTC, datetime

    try:
        parsed = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return datetime.now(UTC)
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


def update_world_model(
    evidence: Evidence,
    world_model: WorldModel,
    diagnostics: Diagnostics,
    belief_input: dict[str, Any] | None = None,
    region_key: str | None = None,
    prune: bool | None = None,
) -> None:
    """Integrate `evidence` (TS updateWorldModel). `belief_input` = {id?, statement?, derived_from}."""
    recorded_at = _parse_iso(evidence.freshness)

    if evidence.evidence_type in ("OBSERVATION", "SYSTEM_ERROR"):
        world_model.add_observation(
            Observation(id=evidence.id, content=evidence.obs, source=evidence.source, recorded_at=recorded_at)
        )
        key = region_key if region_key is not None else evidence.source
        world_model.completeness_flags[key] = prune is not True
    elif evidence.evidence_type == "INFERENCE":
        belief_input = belief_input or {}
        world_model.add_belief(
            Belief(
                id=belief_input.get("id") or evidence.id,
                statement=belief_input.get("statement") or evidence.obs,
                confidence=_reliability_to_float(evidence.reliability),
                supporting_evidence=[],
                reliability="",
                derived_from=list(belief_input.get("derived_from") or []),
                recorded_at=recorded_at,
            )
        )
        if region_key:
            world_model.completeness_flags[region_key] = prune is not True

    recompute_belief_health(world_model, diagnostics)
    world_model.generation_id += 1


def recompute_belief_health(world_model: WorldModel, diagnostics: Diagnostics) -> None:
    """Refresh belief_health freshness / consistency / support from the world model (TS recomputeBeliefHealth)."""
    belief_count = len(world_model.beliefs)
    stale_ratio = sum(1 for v in world_model.stale_flags.values() if v) / max(1, belief_count)
    diagnostics.belief_health.freshness = normalise(1 - stale_ratio, "ratio")

    density = min(1.0, len(world_model.contradictions) / belief_count) if belief_count > 0 else 0.0
    diagnostics.belief_health.consistency = normalise(1 - density, "ratio")

    mean_support = sum(b.confidence for b in world_model.beliefs) / belief_count if belief_count > 0 else 1.0
    diagnostics.belief_health.support = normalise(mean_support, "ratio")


_RELIABILITY_ORDER = {"LOW": 0, "MEDIUM": 1, "HIGH": 2}


def integrate_evidence(evidence_store: Any, world_model: WorldModel, reliability_threshold: str = "HIGH") -> None:
    """Bulk helper for the canvas `update_world_model` node compiler (Python-only): add every store entry at or
    above `reliability_threshold` as an observation. Never creates beliefs (INV-01); the per-evidence TS-shaped
    entry point is update_world_model()."""
    threshold = _RELIABILITY_ORDER.get(reliability_threshold, 2)
    known = {o.id for o in world_model.observations}
    for entry in evidence_store.observations:
        if _RELIABILITY_ORDER.get(entry.reliability, 0) >= threshold and entry.id not in known:
            world_model.add_observation(
                Observation(
                    id=entry.id, content=entry.obs, source=entry.source, recorded_at=_parse_iso(entry.freshness)
                )
            )


def bump_generation(world_model: WorldModel) -> None:
    """Increment generation_id after each world model write cycle (staleness tracking)."""
    world_model.generation_id += 1


__all__ = ["bump_generation", "integrate_evidence", "recompute_belief_health", "update_world_model"]
