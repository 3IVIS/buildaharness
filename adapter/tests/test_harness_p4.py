"""
Phase 4 acceptance tests — Planning & Task Graph.

Tests T01–T13 as specified in plan/phase_4_plan.html.
All tests run without Postgres or Docker infrastructure.

Run: pytest adapter/tests/test_harness_p4.py -v
"""

from __future__ import annotations

import sys
import uuid
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.contradiction import detect_contradictions
from harness.control_state import resolve_control_state
from harness.diagnostics import Diagnostics, update_diagnostics
from harness.evidence import EvidenceStore
from harness.hypothesis import HypothesisSet
from harness.parallel_merge import merge_world_models, reconcile_parallel_branches
from harness.task_graph import (
    ConflictProbabilityCache,
    Task,
    TaskGraph,
    check_abstraction_alignment,
    compute_initial_conflict_probabilities,
    record_actual_overlap,
    select_unblocked_leaf,
    should_use_pessimistic_blocking,
    validate_task_graph,
)
from harness.world_model import Belief, Contradiction, WorldModel

# ── Helpers ───────────────────────────────────────────────────────────────────


def _task(
    tid: str,
    *,
    status: str = "PENDING",
    depends_on: list[str] | None = None,
    risk_level: str = "LOW",
    write_domains: list[str] | None = None,
    abstraction_level: int = 0,
) -> Task:
    return Task(
        id=tid,
        description=f"task {tid}",
        status=status,  # type: ignore[arg-type]
        depends_on=depends_on or [],
        risk_level=risk_level,  # type: ignore[arg-type]
        parallel_write_domains=write_domains or [],
        abstraction_level=abstraction_level,
    )


def _belief(bid: str, statement: str, confidence: float = 0.9) -> Belief:
    return Belief(
        id=bid,
        statement=statement,
        confidence=confidence,
        derived_from=["obs-1"],
    )


def _world_model(*beliefs: Belief, gen: int = 1) -> WorldModel:
    wm = WorldModel(generation_id=gen)
    for b in beliefs:
        wm.beliefs.append(b)
    return wm


def _healthy_diagnostics() -> Diagnostics:
    return Diagnostics()


# ── P4.1 — Task graph with 6-state status ────────────────────────────────────


def test_T01_complete_to_active_raises() -> None:
    """Attempting to transition a COMPLETE task to ACTIVE raises ValueError."""
    graph = TaskGraph(tasks=[_task("A", status="COMPLETE")])
    with pytest.raises(ValueError):
        graph.update_task_status("A", "ACTIVE")


def test_T02_validate_detects_cycle() -> None:
    """validate_task_graph() returns a non-empty error list when A→B and B→A."""
    a = _task("A", depends_on=["B"])
    b = _task("B", depends_on=["A"])
    graph = TaskGraph(tasks=[a, b])
    errors = validate_task_graph(graph)
    assert errors, "expected cycle error but got none"


def test_T03_select_unblocked_leaf() -> None:
    """select_unblocked_leaf() returns None when no PENDING task has all deps COMPLETE;
    returns the correct task when exactly one qualifies."""
    # No task qualifies: B is PENDING but depends on A which is ACTIVE (not COMPLETE)
    a = _task("A", status="ACTIVE")
    b = _task("B", depends_on=["A"])
    graph = TaskGraph(tasks=[a, b])
    assert select_unblocked_leaf(graph) is None

    # Make A COMPLETE: now B (which is PENDING with all deps COMPLETE) qualifies
    a.status = "COMPLETE"
    result = select_unblocked_leaf(graph)
    assert result is not None
    assert result.id == "B"


# ── P4.2 — conflict_probability_cache ────────────────────────────────────────


def test_T04_identical_write_domains_get_1_0() -> None:
    """Tasks with identical parallel_write_domains get initial conflict_probability=1.0."""
    ta = _task("A", write_domains=["state"])
    tb = _task("B", write_domains=["state"])
    graph = TaskGraph(tasks=[ta, tb])
    cache = compute_initial_conflict_probabilities(graph)
    key = cache._key("state", "state")
    assert cache.probabilities[key] == 1.0
    assert should_use_pessimistic_blocking(cache, "state", "state") is True


def test_T05_disjoint_write_domains_get_0_0() -> None:
    """Tasks with fully disjoint parallel_write_domains get initial conflict_probability=0.0."""
    ta = _task("A", write_domains=["domain_a"])
    tb = _task("B", write_domains=["domain_b"])
    graph = TaskGraph(tasks=[ta, tb])
    cache = compute_initial_conflict_probabilities(graph)
    key = cache._key("domain_a", "domain_b")
    assert cache.probabilities[key] == 0.0
    assert should_use_pessimistic_blocking(cache, "domain_a", "domain_b") is False


def test_T06_experience_data_biases_probability_toward_1() -> None:
    """10 observed conflicts for a domain pair raises the cached probability toward 1.0."""
    ta = _task("A", write_domains=["domain_a"])
    tb = _task("B", write_domains=["domain_b"])
    graph = TaskGraph(tasks=[ta, tb])
    cache = compute_initial_conflict_probabilities(graph)

    initial_key = cache._key("domain_a", "domain_b")
    initial_prob = cache.probabilities.get(initial_key, 0.0)
    assert initial_prob == 0.0

    for _ in range(10):
        record_actual_overlap(cache, "domain_a", "domain_b", conflict_observed=True)

    final_prob = cache.probabilities[initial_key]
    assert final_prob > initial_prob, "probability did not increase after 10 conflict observations"
    assert final_prob > 0.5, "expected probability biased toward 1.0 after 10 conflicts"


# ── P4.3 — Parallel branch merge ─────────────────────────────────────────────


def test_T07_merged_generation_id_is_max() -> None:
    """Merged world model has generation_id = max(branch generation_ids)."""
    wm_a = _world_model(gen=3)
    wm_b = _world_model(gen=7)
    wm_c = _world_model(gen=5)
    merged = merge_world_models([wm_a, wm_b, wm_c])
    assert merged.generation_id == 7


def test_T08_optimistic_contradiction_detected_at_merge() -> None:
    """A contradiction present only in the merged model is detected by detect_contradictions()."""
    belief_present = _belief("b1", "The module is present and available", confidence=0.9)
    belief_absent = _belief("b2", "The module is absent and unavailable", confidence=0.9)

    # Neither branch individually has both beliefs
    wm_a = _world_model(belief_present, gen=2)
    wm_b = _world_model(belief_absent, gen=3)

    assert len(wm_a.contradictions) == 0
    assert len(wm_b.contradictions) == 0

    merged = merge_world_models([wm_a, wm_b])
    evidence_store = EvidenceStore()
    hypothesis_set = HypothesisSet()
    detect_contradictions(merged, evidence_store, hypothesis_set)

    assert len(merged.contradictions) > 0, "expected at least one contradiction in merged model from opposed beliefs"


def test_T09_conflict_cache_updated_at_merge() -> None:
    """Actual write domain overlap at merge updates conflict_probability_cache."""
    ta = _task("A", write_domains=["shared"])
    tb = _task("B", write_domains=["shared"])
    cache = ConflictProbabilityCache()
    cache.probabilities[cache._key("shared", "shared")] = 1.0  # pre-seeded

    wm_a = _world_model(gen=2)
    wm_b = _world_model(gen=3)
    diagnostics = _healthy_diagnostics()
    evidence_store = EvidenceStore()
    hypothesis_set = HypothesisSet()

    before_count = cache.observation_counts.get(cache._key("shared", "shared"), 0)
    reconcile_parallel_branches(
        branch_models=[wm_a, wm_b],
        branch_tasks=[ta, tb],
        conflict_cache=cache,
        evidence_store=evidence_store,
        hypothesis_set=hypothesis_set,
        diagnostics=diagnostics,
    )
    after_count = cache.observation_counts.get(cache._key("shared", "shared"), 0)
    assert after_count > before_count, "observation count should increase after reconcile"

    # Subsequent lookup still uses pessimistic blocking (probability was high and True observed)
    assert should_use_pessimistic_blocking(cache, "shared", "shared") is True


def test_T10_system_breaking_contradiction_at_merge_does_not_raise() -> None:
    """SYSTEM_BREAKING contradiction found at merge enters contradictions[] without raising;
    the subsequent resolve returns BLOCKED (INV-05)."""
    # Two beliefs that will generate a SYSTEM_BREAKING contradiction when combined
    b1 = _belief("b1", "The system is present and online", confidence=0.9)
    b2 = _belief("b2", "The system is absent and offline", confidence=0.9)

    wm_a = _world_model(b1, gen=2)
    wm_b = _world_model(b2, gen=3)

    merged = merge_world_models([wm_a, wm_b])

    # Manually inject a SYSTEM_BREAKING contradiction to simulate the worst case
    sys_breaking = Contradiction(
        id=str(uuid.uuid4()),
        type="pairwise",
        severity="SYSTEM_BREAKING",
        scope="global",
        involved_belief_ids=["b1", "b2"],
    )
    merged.add_contradiction(sys_breaking)

    # Merging should never raise
    assert any(c.severity == "SYSTEM_BREAKING" for c in merged.contradictions)

    # resolve_control_state should return BLOCKED
    diagnostics = _healthy_diagnostics()
    control_state = resolve_control_state(
        diagnostics,
        merged,
        failure_diagnostics=None,
        step=merged.generation_id,
    )
    assert control_state.risk_state == "BLOCKED", (
        f"expected BLOCKED after SYSTEM_BREAKING contradiction, got {control_state.risk_state}"
    )


# ── P4.4 — Abstraction fit checking ──────────────────────────────────────────


def test_T11_fine_grained_tasks_against_coarse_world_model_reduce_score() -> None:
    """Tasks with abstraction_level=2 against a module-level (0) world model score < 1.0."""
    # World model with module-level beliefs (no function/line keywords)
    wm = _world_model(
        _belief("b1", "The auth module handles login", confidence=0.9),
        _belief("b2", "The storage module persists data", confidence=0.9),
    )
    # abstraction_level=2 = statement-level, wm_granularity=0 = module-level
    # 2 > 0+1=1, so task is mismatched
    graph = TaskGraph(
        tasks=[_task("T1", abstraction_level=2)],
        changed=True,
    )
    score = check_abstraction_alignment(graph, wm)
    assert score < 1.0, f"expected score < 1.0 for misaligned abstraction, got {score}"

    # Feasibility should be reduced when wired into diagnostics
    diagnostics = Diagnostics()
    original_feasibility = diagnostics.verification_health.feasibility
    update_diagnostics(
        diagnostics,
        wm,
        HypothesisSet(),
        EvidenceStore(),
        task_graph=graph,
    )
    assert diagnostics.verification_health.feasibility < original_feasibility, (
        "feasibility should decrease when alignment score < 1.0"
    )


def test_T12_matching_abstraction_levels_produce_score_1_0() -> None:
    """All tasks matching world model granularity produce alignment score = 1.0."""
    # Module-level world model beliefs (no function/line keywords)
    wm = _world_model(
        _belief("b1", "The cache module is active", confidence=0.9),
    )
    # Tasks at module level (abstraction_level=0) — wm_granularity=0, 0 <= 0+1, no mismatch
    graph = TaskGraph(
        tasks=[
            _task("T1", abstraction_level=0),
            _task("T2", abstraction_level=0),
        ],
        changed=True,
    )
    score = check_abstraction_alignment(graph, wm)
    assert score == 1.0, f"expected 1.0 for perfectly aligned tasks, got {score}"


def test_T13_force_true_computes_regardless_of_changed_flag() -> None:
    """check_abstraction_alignment(force=True) computes the score even when
    task_graph.changed = False."""
    wm = _world_model(
        _belief("b1", "The deployment module is healthy", confidence=0.9),
    )
    # abstraction_level=2 would produce a score below 1.0, but changed=False
    graph = TaskGraph(
        tasks=[_task("T1", abstraction_level=2)],
        changed=False,  # no recompute without force
    )

    # Without force: should return 1.0 (no recomputation)
    score_no_force = check_abstraction_alignment(graph, wm, force=False)
    assert score_no_force == 1.0, "expected 1.0 when changed=False and force=False"

    # With force: should compute the real alignment score (which should be < 1.0)
    score_forced = check_abstraction_alignment(graph, wm, force=True)
    assert score_forced < 1.0, f"expected score < 1.0 when force=True with misaligned tasks, got {score_forced}"
