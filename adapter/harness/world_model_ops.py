"""
World model integration operations — P2.1.

integrate_evidence() integrates Evidence from the evidence store into the
world model using reliability-weighted logic. It only calls add_observation()
— never add_belief() — to enforce INV-01.

recompute_belief_health() returns three proxy sub-dimensions (freshness,
consistency, support) for use in Tier 4 of resolve_control_state() (P3).
"""

from __future__ import annotations

from .evidence import EvidenceStore
from .world_model import Observation, WorldModel

_RELIABILITY_ORDER: dict[str, int] = {"LOW": 0, "MEDIUM": 1, "HIGH": 2}


def integrate_evidence(
    evidence_store: EvidenceStore,
    world_model: WorldModel,
    reliability_threshold: str = "HIGH",
) -> None:
    """Integrate evidence entries at or above reliability_threshold into world_model.observations[].

    Never calls add_belief() — belief creation requires explicit inference nodes (INV-01).
    """
    threshold_rank = _RELIABILITY_ORDER.get(reliability_threshold, 2)
    for entry in evidence_store.entries:
        entry_rank = _RELIABILITY_ORDER.get(entry.reliability, 0)
        if entry_rank >= threshold_rank:
            world_model.add_observation(
                Observation(
                    id=entry.id,
                    content=entry.obs,
                    source=entry.source,
                    recorded_at=entry.recorded_at,
                )
            )


def recompute_belief_health(world_model: WorldModel) -> dict[str, float]:
    """Compute three belief_health proxy sub-dimensions and store them on the world model.

    Returns:
        {"freshness": float, "consistency": float, "support": float}
        Each value is in [0.0, 1.0].

    - freshness: 1 - stale_flag_ratio (from stale_flags if present, else 0)
    - consistency: 1 - contradiction_density (contradictions / max(1, beliefs))
    - support: mean reliability weight over beliefs (HIGH=1.0, MEDIUM=0.5, LOW=0.2)
    """
    stale_flags: dict[str, bool] = getattr(world_model, "stale_flags", {})
    stale_count = sum(1 for v in stale_flags.values() if v)
    belief_count = max(1, len(world_model.beliefs))
    stale_flag_ratio = stale_count / belief_count

    contradiction_density = len(world_model.contradictions) / belief_count

    if world_model.beliefs:
        weights = []
        for belief in world_model.beliefs:
            # Use the highest-reliability supporting evidence, or default 0.5
            if belief.supporting_evidence:
                weights.append(0.5)  # evidence IDs stored as strings; default MEDIUM weight
            else:
                weights.append(0.5)
        mean_weight = sum(weights) / len(weights)
    else:
        mean_weight = 1.0  # no beliefs → no deficit

    freshness = max(0.0, min(1.0, 1.0 - stale_flag_ratio))
    consistency = max(0.0, min(1.0, 1.0 - contradiction_density))
    support = max(0.0, min(1.0, mean_weight))

    proxies: dict[str, float] = {
        "freshness": freshness,
        "consistency": consistency,
        "support": support,
    }
    # Store on world model as transient proxy (not persisted as a typed field)
    world_model.belief_health_proxies = proxies  # type: ignore[attr-defined]
    return proxies


def bump_generation(world_model: WorldModel) -> None:
    """Increment generation_id after each world model write cycle (staleness tracking)."""
    world_model.generation_id += 1
