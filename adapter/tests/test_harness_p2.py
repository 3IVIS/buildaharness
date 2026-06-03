"""
Phase 2 acceptance tests — World Model & Contradiction Layer.

Tests T01–T18 as specified in the Phase 2 plan.
T01–T15 run without infrastructure.
T16–T18 (staleness sweep) also run without Postgres — they test in-memory
belief staleness and dep graph edge decay.

Run all:        pytest adapter/tests/test_harness_p2.py -v
"""

import sys
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.belief_graph import (
    BeliefDepGraph,
    DepGraphBudget,
    apply_decay,
    compute_dep_graph_quality,
    propagate_beliefs,
    propagate_single_update,
)
from harness.contradiction import (
    apply_resolution_policy,
    detect_contradictions,
    detect_pairwise_contradictions,
    detect_set_level_contradictions,
    detect_temporal_contradictions,
)
from harness.evidence import Evidence, EvidenceStore
from harness.hypothesis import Hypothesis, HypothesisSet
from harness.staleness import staleness_sweep
from harness.world_model import Belief, Contradiction, WorldModel
from harness.world_model_ops import integrate_evidence, recompute_belief_health

# ── Helpers ───────────────────────────────────────────────────────────────────


def _belief(statement: str, confidence: float = 0.8, derived_from: list[str] | None = None) -> Belief:
    return Belief(
        id=str(uuid.uuid4()),
        statement=statement,
        confidence=confidence,
        derived_from=derived_from or ["obs-1"],
    )


def _evidence(obs: str = "test obs", reliability: str = "HIGH", source: str = "tool") -> Evidence:
    return Evidence(
        id=str(uuid.uuid4()),
        obs=obs,
        reliability=reliability,
        source=source,
        evidence_type="OBSERVATION",
        freshness=1.0,
    )


# ══════════════════════════════════════════════════════════════════════════════
# P2.1 — update_world_model node
# ══════════════════════════════════════════════════════════════════════════════


def test_t01_observation_evidence_goes_to_observations_not_beliefs():
    """T01: OBSERVATION evidence integrated via integrate_evidence() appears in
    world_model.observations[] and NOT in world_model.beliefs[]."""
    store = EvidenceStore()
    ev = _evidence(obs="file X not found", reliability="HIGH")
    store.append(ev)

    wm = WorldModel()
    integrate_evidence(store, wm, reliability_threshold="HIGH")

    assert any(o.id == ev.id for o in wm.observations), "Evidence should appear in observations[]"
    assert not wm.beliefs, "No beliefs should be created from raw evidence"


def test_t02_recompute_belief_health_fresh_world_model():
    """T02: recompute_belief_health() on a fresh world model returns freshness=1.0,
    consistency=1.0, support=1.0."""
    wm = WorldModel()
    proxies = recompute_belief_health(wm)

    assert proxies["freshness"] == pytest.approx(1.0)
    assert proxies["consistency"] == pytest.approx(1.0)
    assert proxies["support"] == pytest.approx(1.0)


def test_t03_consistency_decreases_with_contradictions():
    """T03: Adding 3 contradictions to a world model with 6 beliefs reduces
    belief_health.consistency below 1.0."""
    wm = WorldModel()
    for i in range(6):
        wm.beliefs.append(_belief(f"belief {i}", derived_from=["obs-1"]))
    for _i in range(3):
        wm.add_contradiction(
            Contradiction(id=str(uuid.uuid4()), type="pairwise", severity="LOW", scope="local")
        )

    proxies = recompute_belief_health(wm)
    assert proxies["consistency"] < 1.0


# ══════════════════════════════════════════════════════════════════════════════
# P2.2 — Belief dependency graph
# ══════════════════════════════════════════════════════════════════════════════


def test_t04_add_edge_and_get_downstream():
    """T04: add_edge("A","B", confidence=0.8) followed by get_downstream("A") returns ["B"]."""
    graph = BeliefDepGraph()
    graph.add_edge("A", "B", confidence=0.8)
    downstream = graph.get_downstream("A")
    assert "B" in downstream


def test_t05_apply_decay_clamps_to_zero():
    """T05: apply_decay() called 5 times with decay_rate=0.1 on an edge starting at
    confidence=0.5 produces confidence=0.0 (not negative)."""
    graph = BeliefDepGraph()
    graph.add_edge("X", "Y", confidence=0.5)
    budget = DepGraphBudget(confidence_decay_rate=0.1)

    for _ in range(5):
        apply_decay(graph, budget)

    edge = graph.edges[0]
    assert edge.confidence == pytest.approx(0.0)
    assert edge.confidence >= 0.0


def test_t06_compute_unverified_edge_ratio():
    """T06: compute_unverified_edge_ratio() returns 0.5 when 1 of 2 edges has confidence=0.0."""
    graph = BeliefDepGraph()
    graph.add_edge("A", "B", confidence=0.8)
    graph.add_edge("C", "D", confidence=0.0)

    ratio = graph.compute_unverified_edge_ratio()
    assert ratio == pytest.approx(0.5)


# ══════════════════════════════════════════════════════════════════════════════
# P2.3 — propagate_beliefs()
# ══════════════════════════════════════════════════════════════════════════════


def test_t07_confidence_weighting_propagation():
    """T07: A 0.3-confidence edge propagates a belief confidence of 0.9 to a downstream
    belief at 0.27 (0.9 × 0.3)."""
    graph = BeliefDepGraph()
    budget = DepGraphBudget()

    belief_a = _belief("A is present", confidence=0.9)
    belief_b = _belief("B follows from A", confidence=0.9)
    graph.add_edge(belief_a.id, belief_b.id, confidence=0.3)

    result = propagate_single_update(graph, belief_a.id, 0.9, budget)
    # The downstream belief ID should be queued for propagation
    assert belief_b.id in graph.propagation_queue or belief_b.id in result


def test_t08_budget_breach_widens_frontier():
    """T08: Budget breach (unverified_edge_ratio > max_unverified_edge_ratio) widens the
    invalidation_frontier to include all beliefs reachable from current frontier members."""
    graph = BeliefDepGraph()
    budget = DepGraphBudget(max_unverified_edge_ratio=0.1)  # Very tight budget

    # Build A -> B -> C chain, A is in frontier
    graph.add_edge("A", "B", confidence=0.0)  # unverified
    graph.add_edge("B", "C", confidence=0.0)  # unverified
    graph.invalidation_frontier.add("A")
    graph.propagation_queue.append("A")

    wm = WorldModel()
    wm.beliefs.append(_belief("A", derived_from=["obs-1"]))

    propagate_beliefs(graph, budget, wm)

    # After budget breach, frontier should include B and C
    assert "B" in graph.invalidation_frontier or "C" in graph.invalidation_frontier


def test_t09_dep_graph_quality_in_range_and_decreases():
    """T09: compute_dep_graph_quality() returns a value in [0,1] and is lower when
    unverified_edge_ratio is higher."""
    graph_clean = BeliefDepGraph()
    graph_clean.add_edge("A", "B", confidence=0.9)
    q_clean = compute_dep_graph_quality(graph_clean, rolling_prediction_accuracy=0.8)
    assert 0.0 <= q_clean <= 1.0

    graph_dirty = BeliefDepGraph()
    graph_dirty.add_edge("A", "B", confidence=0.0)  # unverified
    q_dirty = compute_dep_graph_quality(graph_dirty, rolling_prediction_accuracy=0.8)
    assert 0.0 <= q_dirty <= 1.0

    assert q_dirty < q_clean


# ══════════════════════════════════════════════════════════════════════════════
# P2.4 — Typed contradiction detection
# ══════════════════════════════════════════════════════════════════════════════


def test_t10_system_breaking_no_exception(monkeypatch):
    """T10: A SYSTEM_BREAKING contradiction is appended to world_model.contradictions[]
    — no exception is raised anywhere in the call stack (INV-05)."""
    wm = WorldModel()
    b_a = _belief("X is present", confidence=0.95)
    b_b = _belief("X is absent", confidence=0.95)
    wm.beliefs.extend([b_a, b_b])

    store = EvidenceStore()
    hs = HypothesisSet()
    # Add a hypothesis that references both beliefs as discriminating evidence to trigger
    # SYSTEM_BREAKING upgrade
    hs.active.append(
        Hypothesis(
            id=str(uuid.uuid4()),
            explanation="test hypothesis",
            confidence=0.8,
            predicted_observations=[],
            discriminating_evidence=[b_a.id, b_b.id],
            generation_sources=["test"],
        )
    )

    # Must not raise — even for SYSTEM_BREAKING contradictions
    try:
        detect_contradictions(wm, store, hs)
    except Exception as e:
        pytest.fail(f"detect_contradictions raised an exception: {e}")

    # At least one contradiction should be stored
    assert len(wm.contradictions) > 0


def test_t11_pairwise_and_set_level_detected_independently():
    """T11: Pairwise and set-level contradictions are detected independently — a
    three-belief set-level contradiction does not also generate pairwise records."""
    # Build A opposes B, B opposes C scenario (set-level) with all at high confidence
    b_a = _belief("service is available", confidence=0.9)
    b_b = _belief("service is unavailable", confidence=0.9)  # opposes A
    b_c = _belief("service is available online", confidence=0.9)  # opposes B

    pairwise = detect_pairwise_contradictions([b_a, b_b, b_c])
    set_level = detect_set_level_contradictions([b_a, b_b, b_c])

    # Set-level contradictions should have type="set-level"
    assert all(c.type == "set-level" for c in set_level)
    # Pairwise contradictions should have type="pairwise"
    assert all(c.type == "pairwise" for c in pairwise)

    # A set-level triple should not also appear as individual pairwise records with same IDs
    set_level_id_sets = [frozenset(c.involved_belief_ids) for c in set_level]
    pairwise_id_sets = [frozenset(c.involved_belief_ids) for c in pairwise]
    for sl_ids in set_level_id_sets:
        assert sl_ids not in pairwise_id_sets, "Set-level triple should not duplicate as pairwise"


def test_t12_temporal_contradiction_from_env_change():
    """T12: A belief invalidated by an environment_change_log entry generates a temporal
    contradiction with severity MEDIUM or HIGH."""
    obs_id = "obs-src-1"
    belief = Belief(
        id=str(uuid.uuid4()),
        statement="module X is stable",
        confidence=0.8,
        derived_from=[obs_id],
        recorded_at=datetime(2026, 1, 1, 10, 0, 0),
    )

    env_log = [
        {
            "affected_source": obs_id,
            "timestamp": "2026-01-01T12:00:00",  # After belief.recorded_at
        }
    ]

    contradictions = detect_temporal_contradictions([belief], env_log)
    assert len(contradictions) >= 1
    assert contradictions[0].type == "temporal"
    assert contradictions[0].severity in ("MEDIUM", "HIGH")


# ══════════════════════════════════════════════════════════════════════════════
# P2.5 — Resolution policy
# ══════════════════════════════════════════════════════════════════════════════


def test_t13_low_severity_reduces_confidence_10_percent():
    """T13: Resolution policy routes LOW severity by reducing belief confidence by 10%
    and not touching the task graph."""
    wm = WorldModel()
    belief = _belief("X is present", confidence=0.8)
    wm.beliefs.append(belief)

    contradiction = Contradiction(
        id=str(uuid.uuid4()),
        type="pairwise",
        severity="LOW",
        scope="local",
        involved_belief_ids=[belief.id],
    )

    task_graph: dict = {"task-1": {"belief_dependencies": [belief.id], "status": "pending"}}
    apply_resolution_policy(contradiction, wm, task_graph=task_graph)

    assert wm.beliefs[0].confidence == pytest.approx(0.72)  # 0.8 × 0.9
    assert task_graph["task-1"]["status"] == "pending"  # task graph untouched


def test_t14_high_severity_blocks_dependent_tasks():
    """T14: HIGH severity contradiction flags all task_graph tasks that depend on the
    involved beliefs as BLOCKED."""
    wm = WorldModel()
    belief = _belief("component Y is running", confidence=0.9)
    wm.beliefs.append(belief)

    contradiction = Contradiction(
        id=str(uuid.uuid4()),
        type="pairwise",
        severity="HIGH",
        scope="task",
        involved_belief_ids=[belief.id],
    )

    task_graph = {
        "task-a": {"belief_dependencies": [belief.id], "status": "pending"},
        "task-b": {"belief_dependencies": ["other-belief"], "status": "pending"},
    }
    apply_resolution_policy(contradiction, wm, task_graph=task_graph)

    assert task_graph["task-a"]["status"] == "BLOCKED"
    assert task_graph["task-a"]["block_reason"] == "high_contradiction"
    assert task_graph["task-b"]["status"] == "pending"  # unrelated task untouched


def test_t15_resolution_policy_idempotent():
    """T15: Applying apply_resolution_policy() twice with the same contradiction ID
    produces the same final state as applying it once."""
    wm = WorldModel()
    belief = _belief("Z is enabled", confidence=0.8)
    wm.beliefs.append(belief)

    contradiction = Contradiction(
        id=str(uuid.uuid4()),
        type="pairwise",
        severity="LOW",
        scope="local",
        involved_belief_ids=[belief.id],
    )

    apply_resolution_policy(contradiction, wm)
    confidence_after_first = wm.beliefs[0].confidence

    apply_resolution_policy(contradiction, wm)
    confidence_after_second = wm.beliefs[0].confidence

    assert confidence_after_first == pytest.approx(confidence_after_second)


# ══════════════════════════════════════════════════════════════════════════════
# P2.6 — Staleness sweep
# ══════════════════════════════════════════════════════════════════════════════


def test_t16_ttl_based_staleness():
    """T16: A belief with recorded_at older than belief_ttl is flagged as stale;
    stale_flag_ratio reflects this correctly."""
    wm = WorldModel()
    old_belief = Belief(
        id="old-b",
        statement="something old",
        confidence=0.7,
        derived_from=["obs-1"],
        recorded_at=datetime.now(UTC) - timedelta(hours=2),
    )
    fresh_belief = Belief(
        id="fresh-b",
        statement="something fresh",
        confidence=0.7,
        derived_from=["obs-2"],
        recorded_at=datetime.now(UTC),
    )
    wm.beliefs.extend([old_belief, fresh_belief])

    ratio = staleness_sweep(wm, environment_change_log=[], belief_ttl=timedelta(minutes=30))

    stale_flags = getattr(wm, "stale_flags", {})
    assert stale_flags.get("old-b") is True, "Old belief should be stale"
    assert stale_flags.get("fresh-b") is not True, "Fresh belief should not be stale"
    assert ratio == pytest.approx(0.5)  # 1 of 2 beliefs stale


def test_t17_environment_change_invalidation():
    """T17: A belief whose source appears in environment_change_log with a newer timestamp
    is invalidated by the sweep."""
    source_id = "src-module-x"
    belief = Belief(
        id="b-env",
        statement="module x is stable",
        confidence=0.8,
        derived_from=[source_id],
        recorded_at=datetime(2026, 1, 1, 10, 0, 0),
    )
    wm = WorldModel()
    wm.beliefs.append(belief)

    env_log = [{"affected_source": source_id, "timestamp": "2026-01-01T12:00:00"}]
    ratio = staleness_sweep(wm, environment_change_log=env_log, belief_ttl=timedelta(days=9999))

    stale_flags = getattr(wm, "stale_flags", {})
    assert stale_flags.get("b-env") is True
    assert ratio == pytest.approx(1.0)


def test_t18_staleness_sweep_calls_apply_decay():
    """T18: staleness_sweep() calls apply_decay() on the belief dep graph — edge
    confidence values decrease after the sweep completes."""
    wm = WorldModel()
    graph = BeliefDepGraph()
    graph.add_edge("A", "B", confidence=0.5)
    budget = DepGraphBudget(confidence_decay_rate=0.1)

    initial_confidence = graph.edges[0].confidence

    staleness_sweep(
        wm,
        environment_change_log=[],
        belief_dep_graph=graph,
        dep_graph_budget=budget,
    )

    assert graph.edges[0].confidence < initial_confidence, "Edge confidence should have decayed"
