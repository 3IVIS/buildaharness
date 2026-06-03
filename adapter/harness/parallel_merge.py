"""
Parallel branch merge — P4.3.

reconcile_parallel_branches() runs at a parallel join point to merge world
models from independent branches, resolve generation_id conflicts, detect
contradictions on the merged model, and update the conflict probability cache
from actual write-domain overlap observed.

INV-03: merged generation_id = max(branch generation_ids) — time never retreats.
INV-05: SYSTEM_BREAKING contradictions enter merged.contradictions[] without
        raising; the subsequent resolve_control_state() Tier 1 pass returns BLOCKED.
"""

from __future__ import annotations

from typing import Any

from .contradiction import detect_contradictions
from .control_state import resolve_control_state
from .task_graph import ConflictProbabilityCache, Task, record_actual_overlap
from .world_model import Belief, Contradiction, Observation, WorldModel


def merge_world_models(branch_models: list[WorldModel]) -> WorldModel:
    """Merge parallel branch world models at a join point.

    - generation_id: max across all branches (INV-03 — time only advances)
    - observations: union, deduplicated by ID
    - beliefs: union, deduplicated by ID; on collision keep higher confidence
    - contradictions: union without deduplication — the same contradiction
      appearing in two branches is well-supported evidence
    - environment_change_log: union, sorted by timestamp ascending
    - assumptions: union, deduplicated
    """
    if not branch_models:
        return WorldModel()

    merged_gen = max(m.generation_id for m in branch_models)

    obs_by_id: dict[str, Observation] = {}
    for m in branch_models:
        for obs in m.observations:
            if obs.id not in obs_by_id:
                obs_by_id[obs.id] = obs

    belief_by_id: dict[str, Belief] = {}
    for m in branch_models:
        for b in m.beliefs:
            existing = belief_by_id.get(b.id)
            if existing is None or b.confidence > existing.confidence:
                belief_by_id[b.id] = b

    all_contradictions: list[Contradiction] = []
    for m in branch_models:
        all_contradictions.extend(m.contradictions)

    all_logs: list[dict[str, Any]] = []
    for m in branch_models:
        all_logs.extend(m.environment_change_log)
    all_logs.sort(key=lambda e: e.get("timestamp", ""))

    seen_assumptions: set[str] = set()
    all_assumptions: list[str] = []
    for m in branch_models:
        for a in m.assumptions:
            if a not in seen_assumptions:
                seen_assumptions.add(a)
                all_assumptions.append(a)

    merged = WorldModel(
        generation_id=merged_gen,
        observations=list(obs_by_id.values()),
        beliefs=list(belief_by_id.values()),
        assumptions=all_assumptions,
        contradictions=all_contradictions,
        environment_change_log=all_logs,
    )
    return merged


def reconcile_parallel_branches(
    branch_models: list[WorldModel],
    branch_tasks: list[Task],
    conflict_cache: ConflictProbabilityCache,
    evidence_store: Any,
    hypothesis_set: Any,
    diagnostics: Any,
) -> tuple[WorldModel, Any]:
    """Reconcile parallel branches at a join point.

    Steps:
    1. Merge world models (max generation_id, union observations/beliefs/contradictions).
    2. Run detect_contradictions on the merged model to catch optimistic-path conflicts.
    3. Resolve control state from the merged model and diagnostics.
    4. Compute actual write-domain overlap between branch tasks.
    5. Update conflict_cache with empirical overlap observations.

    Returns (merged_world_model, resolved_control_state).
    """
    # Step 1
    merged = merge_world_models(branch_models)

    # Step 2 — never raises (INV-05); SYSTEM_BREAKING → merged.contradictions[]
    detect_contradictions(merged, evidence_store, hypothesis_set)

    # Step 3
    control_state = resolve_control_state(
        diagnostics,
        merged,
        failure_diagnostics=None,
        step=merged.generation_id,
    )

    # Steps 4 & 5 — update cache from actual write-domain overlap
    for i, task_a in enumerate(branch_tasks):
        for task_b in branch_tasks[i + 1:]:
            for da in task_a.parallel_write_domains:
                for db in task_b.parallel_write_domains:
                    # Conflict when both branches wrote to the same domain
                    conflict_observed = da == db
                    record_actual_overlap(conflict_cache, da, db, conflict_observed)

    return merged, control_state
