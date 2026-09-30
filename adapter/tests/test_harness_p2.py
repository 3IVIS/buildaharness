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
    BeliefNode,
    DepGraphBudget,
    apply_decay,
    compute_dep_graph_quality,
    propagate_beliefs,
)
from harness.contradiction import (
    apply_resolution_policy,
    detect_contradictions,
    detect_pairwise_contradictions,
    detect_set_level_contradictions,
    detect_temporal_contradictions,
    record_external_contradiction,
)
from harness.diagnostics import Diagnostics
from harness.evidence import Evidence, EvidenceStore, ReliabilityClass
from harness.hypothesis import Hypothesis, HypothesisSet
from harness.staleness import staleness_sweep
from harness.world_model import Belief, Contradiction, WorldModel
from harness.world_model_ops import integrate_evidence, recompute_belief_health


@pytest.fixture(autouse=True)
def _lexical_checks_on(monkeypatch):
    """These tests exercise the harness's lexical checks, which are off by default (harness/lexical_off.py)."""
    monkeypatch.setenv("HARNESS_LEXICAL_MODE", "enabled")


# ── Helpers ───────────────────────────────────────────────────────────────────


def _belief(statement: str, confidence: float = 0.8, derived_from: list[str] | None = None) -> Belief:
    return Belief(
        id=str(uuid.uuid4()),
        statement=statement,
        confidence=confidence,
        derived_from=derived_from or ["obs-1"],
    )


def _evidence(obs: str = "test obs", reliability: ReliabilityClass = "HIGH", source: str = "tool") -> Evidence:
    return Evidence(
        id=str(uuid.uuid4()),
        obs=obs,
        reliability=reliability,
        source=source,
        evidence_type="OBSERVATION",
        freshness="2026-01-01T00:00:00+00:00",
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
    """T02: recompute_belief_health() on a fresh world model sets freshness=1.0, consistency=1.0, support=1.0."""
    wm = WorldModel()
    d = Diagnostics()
    d.belief_health.freshness = d.belief_health.consistency = d.belief_health.support = 0.1
    recompute_belief_health(wm, d)

    assert d.belief_health.freshness == pytest.approx(1.0)
    assert d.belief_health.consistency == pytest.approx(1.0)
    assert d.belief_health.support == pytest.approx(1.0)


def test_t03_consistency_decreases_with_contradictions():
    """T03: Adding 3 contradictions to a world model with 6 beliefs reduces
    belief_health.consistency below 1.0."""
    wm = WorldModel()
    for i in range(6):
        wm.beliefs.append(_belief(f"belief {i}", derived_from=["obs-1"]))
    for _i in range(3):
        wm.add_contradiction(Contradiction(id=str(uuid.uuid4()), type="pairwise", severity="LOW", scope="local"))

    d = Diagnostics()
    recompute_belief_health(wm, d)
    assert d.belief_health.consistency == pytest.approx(0.5)  # 1 - 3/6


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
    """T06: unverified_edge_ratio is the share of edges with verified=False (TS recomputeUnverifiedEdgeRatio)."""
    graph = BeliefDepGraph()
    graph.add_edge("A", "B", confidence=0.8, verified=True)
    graph.add_edge("C", "D", confidence=0.0)

    ratio = graph.compute_unverified_edge_ratio()
    assert ratio == pytest.approx(0.5)


# ══════════════════════════════════════════════════════════════════════════════
# P2.3 — propagate_beliefs()
# ══════════════════════════════════════════════════════════════════════════════


def test_t07_confidence_weighting_propagation():
    """T07: a 0.3-confidence edge caps the target node's confidence at source * edge (0.9 x 0.3 = 0.27)."""
    graph = BeliefDepGraph()
    budget = DepGraphBudget()
    graph.belief_nodes = [BeliefNode("A", 0.9), BeliefNode("B", 0.9)]
    graph.add_edge("A", "B", confidence=0.3)

    propagate_beliefs(graph, budget, WorldModel())

    assert graph.belief_nodes[1].confidence == pytest.approx(0.27)


def test_t08_budget_breach_widens_frontier():
    """T08: when unverified_edge_ratio > max_unverified_edge_ratio the frontier gains the direct targets of
    edges whose source is already on it (TS propagateBeliefs; one hop per pass)."""
    graph = BeliefDepGraph()
    budget = DepGraphBudget(max_unverified_edge_ratio=0.1)  # Very tight budget

    graph.add_edge("A", "B", confidence=0.0)  # unverified
    graph.add_edge("B", "C", confidence=0.0)  # unverified
    graph.invalidation_frontier.append("A")

    propagate_beliefs(graph, budget, WorldModel())

    assert graph.invalidation_frontier == ["A", "B"]


def test_t09_dep_graph_quality_in_range_and_decreases():
    """T09: compute_dep_graph_quality() returns a value in [0,1] and is lower when
    unverified_edge_ratio is higher."""
    graph_clean = BeliefDepGraph()
    graph_clean.add_edge("A", "B", confidence=0.9)
    q_clean = compute_dep_graph_quality(graph_clean, rolling_prediction_accuracy=0.8)
    assert 0.0 <= q_clean <= 1.0

    graph_clean.derived_from_edges[0].verified = True
    q_clean = compute_dep_graph_quality(graph_clean, rolling_prediction_accuracy=0.8)
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


# These pairs mirror personal-assistant's CODING_FACT_MARKERS gate (contradiction-checker.ts):
# that gate skips the LLM-backed semantic contradiction check for statements matching it, on the
# assumption this lexical check already covers build/test/service-state claims — so each status
# word the gate recognizes needs its antonym covered here too.
def test_pairwise_contradiction_detected_on_passed_failed_status_flip():
    b_a = _belief("the tests passed", confidence=0.9)
    b_b = _belief("the tests failed", confidence=0.9)
    pairwise = detect_pairwise_contradictions([b_a, b_b])
    assert len(pairwise) == 1
    assert pairwise[0].type == "pairwise"


def test_pairwise_contradiction_detected_on_running_stopped_status_flip():
    b_a = _belief("the server is running", confidence=0.9)
    b_b = _belief("the server is stopped", confidence=0.9)
    pairwise = detect_pairwise_contradictions([b_a, b_b])
    assert len(pairwise) == 1
    assert pairwise[0].type == "pairwise"


def test_pairwise_contradiction_detected_on_online_offline_status_flip():
    b_a = _belief("the database is online", confidence=0.9)
    b_b = _belief("the database is offline", confidence=0.9)
    pairwise = detect_pairwise_contradictions([b_a, b_b])
    assert len(pairwise) == 1
    assert pairwise[0].type == "pairwise"


# Regression: _statements_opposed() used to flag any pair each containing one half of a
# _NEGATION_PAIRS entry, with no requirement that they share a subject — so two totally unrelated
# coding-fact statements (both admissible via CODING_FACT_MARKERS in personal-assistant's
# contradiction-checker.ts) got falsely flagged as contradicting.
def test_no_contradiction_between_unrelated_statements_sharing_a_negation_pair_word():
    b_a = _belief("the login tests passed after the refactor", confidence=0.9)
    b_b = _belief("the payment integration build failed this morning", confidence=0.9)
    pairwise = detect_pairwise_contradictions([b_a, b_b])
    assert len(pairwise) == 0


# Chinese-language fixtures — first-pass phrasing, not verified by a fluent Chinese speaker; see
# the internal plan's Fixture-writing caveat.
def test_pairwise_contradiction_detected_on_chinese_passed_failed_status_flip():
    b_a = _belief("登录测试通过", confidence=0.9)
    b_b = _belief("登录测试失败", confidence=0.9)
    pairwise = detect_pairwise_contradictions([b_a, b_b])
    assert len(pairwise) == 1
    assert pairwise[0].type == "pairwise"


def test_pairwise_contradiction_detected_on_chinese_running_stopped_status_flip():
    b_a = _belief("服务器运行中", confidence=0.9)
    b_b = _belief("服务器已停止", confidence=0.9)
    pairwise = detect_pairwise_contradictions([b_a, b_b])
    assert len(pairwise) == 1
    assert pairwise[0].type == "pairwise"


def test_pairwise_contradiction_detected_on_chinese_online_offline_status_flip():
    b_a = _belief("数据库在线", confidence=0.9)
    b_b = _belief("数据库离线", confidence=0.9)
    pairwise = detect_pairwise_contradictions([b_a, b_b])
    assert len(pairwise) == 1
    assert pairwise[0].type == "pairwise"


def test_no_contradiction_between_unrelated_chinese_statements_sharing_a_negation_pair_character():
    """Character-level mirror of test_no_contradiction_between_unrelated_statements_sharing_a_negation_pair_word:
    both statements each contain one half of the 通过/失败 pair, but share zero non-stopword
    characters, so the sharedTokens gate blocks the false positive."""
    b_a = _belief("登录测试通过", confidence=0.9)
    b_b = _belief("数据库连接失败", confidence=0.9)
    pairwise = detect_pairwise_contradictions([b_a, b_b])
    assert len(pairwise) == 0


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


def test_t14_high_severity_does_not_block_tasks():
    """T14: HIGH severity contradiction only marks the beliefs applied / grows the invalidation
    frontier — it never blocks task_graph tasks (twin of TS resolveHigh in detect-contradictions.ts)."""
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

    assert task_graph["task-a"]["status"] == "pending"
    assert "block_reason" not in task_graph["task-a"]
    assert task_graph["task-b"]["status"] == "pending"
    assert contradiction.id in wm.beliefs[0].applied_contradiction_ids


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
# Phase 2 (lexical hardening plan) — record_external_contradiction
# Python port of packages/harness/src/nodes/detect-contradictions.ts's
# recordExternalContradiction — mirrors that file's own test cases.
# ══════════════════════════════════════════════════════════════════════════════


def test_record_external_contradiction_records_a_semantically_detected_conflict():
    """Records a contradiction the lexical detector would miss (no shared negation-pair keyword)."""
    wm = WorldModel()
    wm.beliefs.append(Belief(id="b1", statement="the user lives in Boston", confidence=0.5, derived_from=["o1"]))
    wm.beliefs.append(Belief(id="b2", statement="the user lives in Seattle", confidence=0.5, derived_from=["o2"]))

    recorded = record_external_contradiction(
        wm, ["b1", "b2"], "The user cannot live in both Boston and Seattle at once."
    )

    assert recorded is not None
    assert len(wm.contradictions) == 1
    assert wm.contradictions[0].severity == "MEDIUM"  # default when the caller omits severity
    assert sorted(wm.contradictions[0].involved_belief_ids) == ["b1", "b2"]
    assert wm.contradictions[0].description == "The user cannot live in both Boston and Seattle at once."
    # Goes through the same resolution policy a lexically-found contradiction does —
    # MEDIUM reduces confidence by 25%.
    assert wm.beliefs[0].confidence == pytest.approx(0.375)


def test_record_external_contradiction_respects_explicit_severity():
    wm = WorldModel()
    wm.beliefs.append(Belief(id="b1", statement="the deployment is healthy", confidence=0.9, derived_from=["o1"]))

    recorded = record_external_contradiction(wm, ["b1"], "Contradicts a HIGH-reliability observation.", severity="HIGH")

    assert recorded is not None
    assert recorded.severity == "HIGH"


def test_record_external_contradiction_skips_an_already_recorded_belief_group():
    """Same involved_belief_ids (any order) is not double-recorded or double-penalised."""
    wm = WorldModel()
    wm.beliefs.append(Belief(id="b1", statement="the user lives in Boston", confidence=0.5, derived_from=["o1"]))
    wm.beliefs.append(Belief(id="b2", statement="the user lives in Seattle", confidence=0.5, derived_from=["o2"]))

    first = record_external_contradiction(wm, ["b1", "b2"], "first description")
    assert first is not None
    confidence_after_first = wm.beliefs[0].confidence

    second = record_external_contradiction(wm, ["b2", "b1"], "same group, different order/description")

    assert second is None
    assert len(wm.contradictions) == 1
    assert wm.beliefs[0].confidence == pytest.approx(confidence_after_first)


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


def test_update_world_model_folds_evidence_in_as_ts_does():
    """update_world_model: OBSERVATION/SYSTEM_ERROR -> observation (+ completeness flag for its region);
    INFERENCE -> belief (needs derived_from), confidence from reliability; generation bumps; health refreshes."""
    from harness.world_model_ops import update_world_model

    wm = WorldModel()
    d = Diagnostics()
    obs = Evidence(id="e1", obs="saw x", reliability="HIGH", source="grep", evidence_type="OBSERVATION")
    update_world_model(obs, wm, d, region_key="src/", prune=True)
    assert [o.id for o in wm.observations] == ["e1"]
    assert wm.completeness_flags == {"src/": False}
    assert wm.generation_id == 1

    inf = Evidence(id="e2", obs="x means y", reliability="MEDIUM", source="grep", evidence_type="INFERENCE")
    with pytest.raises(ValueError):
        update_world_model(inf, wm, d)  # no derived_from chain (INV-01)
    update_world_model(inf, wm, d, belief_input={"id": "b", "derived_from": ["e1"]})
    assert wm.beliefs[0].confidence == 0.5
    assert wm.beliefs[0].id == "b"
    assert d.belief_health.support == pytest.approx(0.5)
