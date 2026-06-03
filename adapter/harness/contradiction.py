"""
Contradiction detection and resolution policy — P2.4 and P2.5.

detect_contradictions() orchestrates four independent detection functions
(pairwise, set-level, temporal, abstraction) and stores all results via
world_model.add_contradiction(). It never raises — SYSTEM_BREAKING
contradictions are routed through Tier 1 of resolve_control_state() in P3
(INV-05).

apply_resolution_policy() is idempotent: repeated calls with the same
contradiction ID produce the same final state.
"""

from __future__ import annotations

import uuid
from typing import Any

from .evidence import EvidenceStore
from .hypothesis import HypothesisSet
from .world_model import Belief, Contradiction, WorldModel

_NEGATION_PAIRS = [
    ("present", "absent"),
    ("true", "false"),
    ("exists", "missing"),
    ("success", "failure"),
    ("available", "unavailable"),
    ("enabled", "disabled"),
    ("found", "not found"),
    ("is", "is not"),
]


def _statements_opposed(stmt_a: str, stmt_b: str) -> bool:
    """Simple keyword negation check: returns True when two statements are semantically opposed."""
    a = stmt_a.lower()
    b = stmt_b.lower()

    # Check direct negation pairs
    for pos, neg in _NEGATION_PAIRS:
        if pos in a and neg in b:
            return True
        if neg in a and pos in b:
            return True

    # Check "not X" vs "X" pattern
    words_a = set(a.split())
    words_b = set(b.split())
    common = words_a & words_b - {"the", "a", "an", "is", "are", "was", "were", "in", "at"}
    if common:
        if ("not" in words_a) != ("not" in words_b):
            return True
        if ("absent" in words_a) != ("absent" in words_b):
            return True
        if ("no" in words_a) != ("no" in words_b):
            return True

    return False


def _confidence_to_class(confidence: float) -> str:
    if confidence >= 0.8:
        return "HIGH"
    if confidence >= 0.5:
        return "MEDIUM"
    return "LOW"


# ── P2.4 detection functions ──────────────────────────────────────────────────


def detect_pairwise_contradictions(beliefs: list[Belief]) -> list[Contradiction]:
    """Detect pairwise semantic oppositions between beliefs."""
    results: list[Contradiction] = []
    for i, b_a in enumerate(beliefs):
        for b_b in beliefs[i + 1 :]:
            if not _statements_opposed(b_a.statement, b_b.statement):
                continue
            if b_a.confidence < 0.5 and b_b.confidence < 0.5:
                continue
            cls_a = _confidence_to_class(b_a.confidence)
            cls_b = _confidence_to_class(b_b.confidence)
            if cls_a == "HIGH" and cls_b == "HIGH":
                severity = "HIGH"
            elif cls_a == "LOW" and cls_b == "LOW":
                severity = "LOW"
            else:
                severity = "MEDIUM"
            results.append(
                Contradiction(
                    id=str(uuid.uuid4()),
                    type="pairwise",
                    severity=severity,
                    scope="local",
                    involved_belief_ids=[b_a.id, b_b.id],
                )
            )
    return results


def detect_set_level_contradictions(beliefs: list[Belief]) -> list[Contradiction]:
    """Detect joint inconsistency in groups of three or more beliefs.

    Uses a simple inference chain check: if A opposes B and B opposes C,
    but C is asserted alongside A, the triple is jointly inconsistent.
    Only flags when all involved beliefs have confidence >= 0.6.
    """
    results: list[Contradiction] = []
    high_conf = [b for b in beliefs if b.confidence >= 0.6]

    # Build opposition adjacency
    opposition: dict[str, list[str]] = {b.id: [] for b in high_conf}
    for i, b_a in enumerate(high_conf):
        for b_b in high_conf[i + 1 :]:
            if _statements_opposed(b_a.statement, b_b.statement):
                opposition[b_a.id].append(b_b.id)
                opposition[b_b.id].append(b_a.id)

    # Check for A→opp→B→opp→C where C is asserted with A
    ids = [b.id for b in high_conf]
    reported: set[frozenset[str]] = set()
    for _i, id_a in enumerate(ids):
        for id_b in opposition.get(id_a, []):
            for id_c in opposition.get(id_b, []):
                if id_c == id_a or id_c == id_b:
                    continue
                # A opposes B, B opposes C — A and C are asserted together
                triple = frozenset([id_a, id_b, id_c])
                if triple in reported:
                    continue
                reported.add(triple)
                results.append(
                    Contradiction(
                        id=str(uuid.uuid4()),
                        type="set-level",
                        severity="HIGH",
                        scope="task",
                        involved_belief_ids=list(triple),
                    )
                )
    return results


def detect_temporal_contradictions(
    beliefs: list[Belief],
    environment_change_log: list[dict[str, Any]],
) -> list[Contradiction]:
    """Detect beliefs invalidated by environment changes.

    MEDIUM severity when change is recent (after belief.recorded_at);
    HIGH severity when the change pre-dates the belief.recorded_at (the
    belief was formed after we already knew the world had changed).
    """
    from datetime import datetime

    results: list[Contradiction] = []
    for belief in beliefs:
        # Gather source references from the belief's derivation chain and evidence IDs
        belief_sources = set(belief.derived_from) | set(belief.supporting_evidence)
        for change in environment_change_log:
            affected_source = change.get("affected_source", "")
            if not affected_source or affected_source not in belief_sources:
                continue
            change_ts_raw = change.get("timestamp") or change.get("recorded_at")
            if change_ts_raw is None:
                continue
            try:
                change_ts = datetime.fromisoformat(str(change_ts_raw))
            except ValueError:
                continue

            belief_ts = belief.recorded_at
            # Normalise both to offset-naive for comparison
            if change_ts.tzinfo is not None:
                change_ts = change_ts.replace(tzinfo=None)
            if belief_ts.tzinfo is not None:
                belief_ts = belief_ts.replace(tzinfo=None)

            if change_ts > belief_ts:
                severity = "MEDIUM"
            else:
                # Change pre-dates the belief — the belief was formed after the invalidating event
                severity = "HIGH"

            results.append(
                Contradiction(
                    id=str(uuid.uuid4()),
                    type="temporal",
                    severity=severity,
                    scope="local",
                    involved_belief_ids=[belief.id],
                )
            )
    return results


def detect_abstraction_contradictions(
    beliefs: list[Belief],
    task_graph: dict[str, Any] | None,
) -> list[Contradiction]:
    """Detect beliefs stated at finer granularity than the current task's abstraction level.

    Abstraction contradictions are advisory (LOW severity) — they surface to
    the reviewer lens (P9) but do not trigger replanning.
    """
    results: list[Contradiction] = []
    if not task_graph:
        return results

    abstraction_level = task_graph.get("abstraction_level", "module")
    # Heuristics: line-level indicators in belief statements
    line_level_keywords = ["line ", "line\t", ":line", " ln ", " L", "column ", "char "]

    if abstraction_level in ("module", "component", "system"):
        for belief in beliefs:
            stmt = belief.statement.lower()
            if any(kw.lower() in stmt for kw in line_level_keywords):
                results.append(
                    Contradiction(
                        id=str(uuid.uuid4()),
                        type="abstraction",
                        severity="LOW",
                        scope="local",
                        involved_belief_ids=[belief.id],
                    )
                )
    return results


def assign_system_breaking_severity(
    contradictions: list[Contradiction],
    hypothesis_set: HypothesisSet,
) -> list[Contradiction]:
    """Upgrade pairwise/set-level HIGH contradictions to SYSTEM_BREAKING when conditions are met.

    Conditions:
    (a) Both involved beliefs have HIGH confidence AND the contradiction already
        has HIGH severity.
    (b) The contradiction is predicted in an active hypothesis as a conflict.

    SYSTEM_BREAKING contradictions are stored via add_contradiction() and picked
    up by Tier 1 of resolve_control_state() in P3 — they never cause inline halts.
    """
    # Build a set of belief ID pairs that appear in active hypothesis predicted conflicts
    hypothesis_conflict_pairs: set[frozenset[str]] = set()
    for hyp in hypothesis_set.active:
        # A hypothesis "predicts" a contradiction when two of its discriminating_evidence
        # IDs map to the belief IDs in conflict.
        for i, ev_a in enumerate(hyp.discriminating_evidence):
            for ev_b in hyp.discriminating_evidence[i + 1 :]:
                hypothesis_conflict_pairs.add(frozenset([ev_a, ev_b]))

    upgraded: list[Contradiction] = []
    for c in contradictions:
        if c.severity != "HIGH" or c.type not in ("pairwise", "set-level"):
            upgraded.append(c)
            continue
        involved_pair = frozenset(c.involved_belief_ids)
        if involved_pair in hypothesis_conflict_pairs:
            from dataclasses import replace
            upgraded.append(replace(c, severity="SYSTEM_BREAKING"))
        else:
            upgraded.append(c)
    return upgraded


def detect_contradictions(
    world_model: WorldModel,
    evidence_store: EvidenceStore,
    hypothesis_set: HypothesisSet,
    task_graph: dict[str, Any] | None = None,
) -> list[Contradiction]:
    """Orchestrate all four detection functions and store results on the world model.

    Never raises — SYSTEM_BREAKING contradictions enter world_model.contradictions[]
    via the same add_contradiction() path as LOW contradictions (INV-05).
    """
    beliefs = world_model.beliefs
    env_log = world_model.environment_change_log

    all_contradictions: list[Contradiction] = []
    all_contradictions.extend(detect_pairwise_contradictions(beliefs))
    all_contradictions.extend(detect_set_level_contradictions(beliefs))
    all_contradictions.extend(detect_temporal_contradictions(beliefs, env_log))
    all_contradictions.extend(detect_abstraction_contradictions(beliefs, task_graph))

    all_contradictions = assign_system_breaking_severity(all_contradictions, hypothesis_set)

    for c in all_contradictions:
        world_model.add_contradiction(c)

    return all_contradictions


# ── P2.5 resolution policy ────────────────────────────────────────────────────


def _resolve_low(contradiction: Contradiction, world_model: WorldModel) -> None:
    """Reduce involved belief confidence by 10% and mark for staleness sweep."""
    for belief in world_model.beliefs:
        if belief.id not in contradiction.involved_belief_ids:
            continue
        applied_ids: set[str] = getattr(belief, "applied_contradiction_ids", set())
        if contradiction.id in applied_ids:
            continue
        belief.confidence = max(0.0, belief.confidence * 0.9)
        applied_ids.add(contradiction.id)
        belief.applied_contradiction_ids = applied_ids  # type: ignore[attr-defined]
        belief.pending_sweep = True  # type: ignore[attr-defined]


def _resolve_medium(
    contradiction: Contradiction,
    world_model: WorldModel,
    belief_dep_graph: Any | None = None,
) -> None:
    """Reduce involved belief confidence by 25% and queue downstream propagation."""
    for belief in world_model.beliefs:
        if belief.id not in contradiction.involved_belief_ids:
            continue
        applied_ids: set[str] = getattr(belief, "applied_contradiction_ids", set())
        if contradiction.id in applied_ids:
            continue
        belief.confidence = max(0.0, belief.confidence * 0.75)
        applied_ids.add(contradiction.id)
        belief.applied_contradiction_ids = applied_ids  # type: ignore[attr-defined]
        belief.pending_sweep = True  # type: ignore[attr-defined]
        if belief_dep_graph is not None and belief.id not in belief_dep_graph.propagation_queue:
            belief_dep_graph.propagation_queue.append(belief.id)


def _resolve_high(
    contradiction: Contradiction,
    world_model: WorldModel,
    task_graph: dict[str, Any] | None,
    belief_dep_graph: Any | None = None,
) -> None:
    """Block all task_graph tasks that depend on involved beliefs; add to invalidation frontier."""
    for belief in world_model.beliefs:
        if belief.id not in contradiction.involved_belief_ids:
            continue
        applied_ids: set[str] = getattr(belief, "applied_contradiction_ids", set())
        if contradiction.id in applied_ids:
            continue
        applied_ids.add(contradiction.id)
        belief.applied_contradiction_ids = applied_ids  # type: ignore[attr-defined]
        if belief_dep_graph is not None:
            belief_dep_graph.invalidation_frontier.add(belief.id)

    if task_graph:
        for task in task_graph.values():
            if not isinstance(task, dict):
                continue
            task_belief_deps = task.get("belief_dependencies", [])
            if any(bid in contradiction.involved_belief_ids for bid in task_belief_deps):
                task["status"] = "BLOCKED"
                task["block_reason"] = "high_contradiction"


def _resolve_system_breaking(
    contradiction: Contradiction,
    world_model: WorldModel,
) -> None:
    """Ensure the SYSTEM_BREAKING contradiction is in world_model.contradictions[] and mark global scope.

    No other action — Tier 1 of resolve_control_state() (P3) handles the rest (INV-05).
    """
    existing_ids = {c.id for c in world_model.contradictions}
    if contradiction.id not in existing_ids:
        world_model.add_contradiction(contradiction)
    # Mutate scope to global
    for c in world_model.contradictions:
        if c.id == contradiction.id:
            c.scope = "global"
            break


def apply_resolution_policy(
    contradiction: Contradiction,
    world_model: WorldModel,
    task_graph: dict[str, Any] | None = None,
    belief_dep_graph: Any | None = None,
) -> None:
    """Route a contradiction to the appropriate resolution handler based on severity.

    Idempotent: each contradiction ID is tracked in belief.applied_contradiction_ids
    to prevent double-penalising when called more than once per loop iteration.
    """
    if contradiction.severity == "LOW":
        _resolve_low(contradiction, world_model)
    elif contradiction.severity == "MEDIUM":
        _resolve_medium(contradiction, world_model, belief_dep_graph)
    elif contradiction.severity == "HIGH":
        _resolve_high(contradiction, world_model, task_graph, belief_dep_graph)
    elif contradiction.severity == "SYSTEM_BREAKING":
        _resolve_system_breaking(contradiction, world_model)
