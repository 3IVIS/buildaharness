"""
Parallel branch merge — P4.3.

reconcile_parallel_branches() runs at a parallel join point to merge world
models from independent branches, resolve generation_id conflicts, detect
contradictions on the merged model, and decay the conflict probability of the parallel domain pairs.

INV-03: merged generation_id = max(branch generation_ids) — time never retreats.
INV-05: SYSTEM_BREAKING contradictions enter merged.contradictions[] without
        raising; the subsequent resolve_control_state() Tier 1 pass returns BLOCKED.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .contradiction import detect_contradictions
from .control_state import resolve_control_state
from .task_graph import TaskGraph
from .world_model import Belief, Contradiction, Observation, WorldModel


@dataclass
class ParallelBranch:
    world_model: WorldModel
    control_state: Any


def merge_world_models(*branch_models: WorldModel) -> WorldModel:
    """Merge parallel branch world models at a join point (TS mergeWorldModels, applied left to right).

    - generation_id: max across all branches (INV-03 — time only advances)
    - observations / beliefs / contradictions: union by id, the later branch winning on a collision
    - assumptions: union, deduplicated (first-seen order)
    - completeness_flags: merged, the later branch winning
    Unlike the earlier Python merge, environment_change_log and stale_flags are not carried over (TS does not).
    """
    if len(branch_models) == 1 and isinstance(branch_models[0], (list, tuple)):
        branch_models = tuple(branch_models[0])  # accept a single list of models too
    merged = WorldModel()
    if not branch_models:
        return merged

    merged.generation_id = max(m.generation_id for m in branch_models)

    beliefs: dict[str, Belief] = {}
    observations: dict[str, Observation] = {}
    contradictions: dict[str, Contradiction] = {}
    assumptions: list[str] = []
    for m in branch_models:
        for b in m.beliefs:
            beliefs[b.id] = b
        for o in m.observations:
            observations[o.id] = o
        for c in m.contradictions:
            contradictions[c.id] = c
        for a in m.assumptions:
            if a not in assumptions:
                assumptions.append(a)
        merged.completeness_flags.update(m.completeness_flags)

    merged.beliefs = list(beliefs.values())
    merged.observations = list(observations.values())
    merged.contradictions = list(contradictions.values())
    merged.assumptions = assumptions
    return merged


@dataclass
class ReconcileResult:
    world_model: WorldModel
    control_state: Any


def reconcile_parallel_branches(
    branches: list[ParallelBranch],
    task_graph: TaskGraph,
    diagnostics: Any,
    failure_diagnostics: Any,
    evidence_store: Any,
    hypothesis_set: Any,
    resolver: Callable[[Any, WorldModel, Any], Any] | None = None,
    parallel_domain_pairs: list[tuple[str, str]] | None = None,
) -> ReconcileResult:
    """Reconcile parallel branches at a join point (TS reconcileParallelBranches).

    Steps: merge the branch world models (max generation_id); run detect_contradictions on the merged model to catch
    optimistic-path conflicts; resolve control state from it (stamped with the merged generation_id); decay the
    conflict probability of each given domain pair by x0.9 (only pairs that already have a positive probability).
    """
    if not branches:
        raise ValueError("reconcile_parallel_branches: no branches provided")

    max_gen = max(b.world_model.generation_id for b in branches)

    merged = branches[0].world_model
    for branch in branches[1:]:
        merged = merge_world_models(merged, branch.world_model)
    merged.generation_id = max_gen

    detect_contradictions(merged, evidence_store, hypothesis_set)

    if resolver is not None:
        merged_cs = resolver(diagnostics, merged, failure_diagnostics)
    else:
        merged_cs = resolve_control_state(diagnostics, merged, failure_diagnostics, step=merged.generation_id)
    merged_cs.generation_id = merged.generation_id

    for da, db in parallel_domain_pairs or []:
        existing = task_graph.get_conflict_probability(da, db)
        task_graph.set_conflict_probability(da, db, existing * 0.9 if existing > 0 else 0)

    return ReconcileResult(world_model=merged, control_state=merged_cs)
