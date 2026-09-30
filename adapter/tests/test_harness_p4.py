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

from harness.belief_graph import BeliefDepGraph
from harness.contradiction import detect_contradictions
from harness.control_state import ControlState, resolve_control_state
from harness.diagnostics import Diagnostics, update_diagnostics
from harness.evidence import EvidenceStore
from harness.failure_modes import FailureDiagnostics
from harness.hypothesis import HypothesisSet
from harness.parallel_merge import ParallelBranch, merge_world_models, reconcile_parallel_branches
from harness.task_graph import (
    GraphCycleError,
    Task,
    TaskGraph,
    check_abstraction_alignment,
    make_conflict_key,
    select_task,
    select_unblocked_leaf,
    update_task_graph,
    validate_task_graph,
)
from harness.world_model import Belief, Contradiction, WorldModel


@pytest.fixture(autouse=True)
def _lexical_checks_on(monkeypatch):
    """These tests exercise the harness's lexical checks, which are off by default (harness/lexical_off.py)."""
    monkeypatch.setenv("HARNESS_LEXICAL_MODE", "enabled")


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


def test_T01_complete_is_terminal_and_failed_needs_execution_layer() -> None:
    """COMPLETE is terminal; FAILED can only be set by the execution layer (TS TaskGraph.setStatus)."""
    graph = TaskGraph(tasks=[_task("A", status="COMPLETE"), _task("B")])
    with pytest.raises(ValueError, match="terminal"):
        graph.set_status("A", "RUNNING")
    with pytest.raises(ValueError, match="execution layer"):
        graph.set_status("B", "FAILED")
    graph.set_status("B", "FAILED", from_execution_layer=True)
    assert graph.get_task("B").status == "FAILED"
    assert graph.changed is True
    with pytest.raises(ValueError, match="not found"):
        graph.set_status("nope", "RUNNING")


def test_T02_cycle_detection_and_orphan_validation() -> None:
    """update_task_graph() raises GraphCycleError for A→B→A; validate_task_graph() reports orphaned dependencies."""
    graph = TaskGraph(tasks=[_task("A", depends_on=["B"]), _task("B", depends_on=["A"])])
    with pytest.raises(GraphCycleError):
        update_task_graph(None, None, None, graph)

    orphan = TaskGraph(tasks=[_task("A", depends_on=["ghost"])])
    assert validate_task_graph(orphan) == ['Task "A" depends on unknown task "ghost"']
    assert validate_task_graph(TaskGraph(tasks=[_task("A")])) == []


def test_T03_select_unblocked_leaf() -> None:
    """select_unblocked_leaf() returns None when no PENDING task has all deps COMPLETE;
    returns the correct task when exactly one qualifies."""
    # No task qualifies: B is PENDING but depends on A which is RUNNING (not COMPLETE)
    a = _task("A", status="RUNNING")
    b = _task("B", depends_on=["A"])
    graph = TaskGraph(tasks=[a, b])
    assert select_unblocked_leaf(graph) is None

    # Make A COMPLETE: now B (which is PENDING with all deps COMPLETE) qualifies
    a.status = "COMPLETE"
    result = select_unblocked_leaf(graph)
    assert result is not None
    assert result.id == "B"


# ── P4.2 — conflict_probability_cache ────────────────────────────────────────


def test_T04_shared_write_domain_gets_same_domain_probability() -> None:
    """update_task_graph seeds conflict_probability_cache: two tasks writing the same domain get
    min(1, count / #tasks) = 1.0 for that domain against itself."""
    graph = TaskGraph(tasks=[_task("A", write_domains=["state"]), _task("B", write_domains=["state"])])
    update_task_graph(None, None, None, graph)
    assert graph.conflict_probability_cache[make_conflict_key("state", "state")] == 1.0
    assert graph.get_conflict_probability("state", "state") == 1.0


def test_T05_disjoint_write_domains_are_seeded_by_prevalence() -> None:
    """Different domains get min(1, (countA + countB) / (2 * #tasks)); same-domain needs >= 2 writers."""
    graph = TaskGraph(tasks=[_task("A", write_domains=["domain_a"]), _task("B", write_domains=["domain_b"])])
    update_task_graph(None, None, None, graph)
    assert graph.get_conflict_probability("domain_a", "domain_b") == pytest.approx(0.5)
    assert graph.get_conflict_probability("domain_a", "domain_a") == 0  # only one writer -> not seeded
    assert make_conflict_key("domain_b", "domain_a") == "domain_a::domain_b"


def test_T06_select_task_runs_second_task_concurrently_unless_pessimistic() -> None:
    """select_task picks the highest-risk ready task, plus the next one when their write domains do not overlap or the
    recorded conflict probability is <= 0.5 (PESSIMISTIC_THRESHOLD); > 0.5 serialises them; HUMAN_REQUIRED escalates."""
    high = _task("H", risk_level="HIGH", write_domains=["x"])
    low = _task("L", risk_level="LOW", write_domains=["y"])
    graph = TaskGraph(tasks=[low, high])
    result = select_task(graph, ControlState())
    assert (result.task.id, result.concurrent_task.id, result.escalate) == ("H", "L", False)

    overlap = TaskGraph(tasks=[_task("A", risk_level="HIGH", write_domains=["s"]), _task("B", write_domains=["s"])])
    overlap.set_conflict_probability("s", "s", 0.8)
    result = select_task(overlap, ControlState())
    assert (result.task.id, result.concurrent_task) == ("A", None)
    overlap.set_conflict_probability("s", "s", 0.4)
    assert select_task(overlap, ControlState()).concurrent_task.id == "B"

    assert select_task(graph, ControlState(escalation_reason="HUMAN_REQUIRED")).escalate is True
    assert select_task(TaskGraph(), ControlState()).task is None


# ── P4.3 — Parallel branch merge ─────────────────────────────────────────────


def test_T07_merged_generation_id_is_max() -> None:
    """Merged world model has generation_id = max(branch generation_ids)."""
    wm_a = _world_model(gen=3)
    wm_b = _world_model(gen=7)
    wm_c = _world_model(gen=5)
    merged = merge_world_models(wm_a, wm_b, wm_c)
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

    merged = merge_world_models(wm_a, wm_b)
    evidence_store = EvidenceStore()
    hypothesis_set = HypothesisSet()
    detect_contradictions(merged, evidence_store, hypothesis_set)

    assert len(merged.contradictions) > 0, "expected at least one contradiction in merged model from opposed beliefs"


def test_T09_reconcile_decays_domain_pair_probability() -> None:
    """reconcile_parallel_branches decays the conflict probability of each given domain pair by x0.9 (only pairs that
    already have a positive probability), stamps the merged generation_id on the resolved control state."""
    graph = TaskGraph(tasks=[_task("A", write_domains=["shared"]), _task("B", write_domains=["shared"])])
    graph.set_conflict_probability("shared", "shared", 1.0)

    result = reconcile_parallel_branches(
        [ParallelBranch(_world_model(gen=2), ControlState()), ParallelBranch(_world_model(gen=3), ControlState())],
        graph,
        _healthy_diagnostics(),
        FailureDiagnostics(),
        EvidenceStore(),
        HypothesisSet(),
        parallel_domain_pairs=[("shared", "shared"), ("a", "b")],
    )
    assert graph.get_conflict_probability("shared", "shared") == pytest.approx(0.9)
    assert graph.get_conflict_probability("a", "b") == 0
    assert result.world_model.generation_id == 3
    assert result.control_state.generation_id == 3


def test_T09b_merge_semantics() -> None:
    """Union by id with the later branch winning; assumptions deduplicated; completeness merged; the environment
    change log is not carried over (TS mergeWorldModels)."""
    a = _world_model(_belief("b1", "first"), gen=1)
    b = _world_model(_belief("b1", "second"), gen=2)
    a.assumptions = ["x", "y"]
    b.assumptions = ["y", "z"]
    a.completeness_flags = {"r": True}
    b.completeness_flags = {"r": False}
    a.environment_change_log = [{"id": "c"}]
    merged = merge_world_models(a, b)
    assert [x.statement for x in merged.beliefs] == ["second"]
    assert merged.assumptions == ["x", "y", "z"]
    assert merged.completeness_flags == {"r": False}
    assert merged.environment_change_log == []


def test_T10_system_breaking_contradiction_at_merge_does_not_raise() -> None:
    """SYSTEM_BREAKING contradiction found at merge enters contradictions[] without raising;
    the subsequent resolve returns BLOCKED (INV-05)."""
    # Two beliefs that will generate a SYSTEM_BREAKING contradiction when combined
    b1 = _belief("b1", "The system is present and online", confidence=0.9)
    b2 = _belief("b2", "The system is absent and offline", confidence=0.9)

    wm_a = _world_model(b1, gen=2)
    wm_b = _world_model(b2, gen=3)

    merged = merge_world_models(wm_a, wm_b)

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
    assert control_state.permission == "DENY", (
        f"expected DENY after SYSTEM_BREAKING contradiction, got {control_state.permission}"
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
    update_diagnostics(wm, HypothesisSet(), graph, FailureDiagnostics(), BeliefDepGraph(), diagnostics)
    # composite [0.6 tool, 0.4 evidence, alignment 0.0] / (1 + 1 + 0.3) with no completeness flags / observations
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
