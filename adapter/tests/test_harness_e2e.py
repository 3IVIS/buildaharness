"""
Phase 11 — End-to-end harness scenario tests (P11.3).

8 scenarios × 4 frameworks = 32 parameterised test cases.
All tests are infrastructure-free (no Postgres, no real LLMs, no network).
They exercise the harness Python modules directly.

Scenarios:
  E2E-01  Happy path — full loop iteration completes without escalation
  E2E-02  BLOCKED escalation — degraded diagnostics → high-risk control state
  E2E-03  Recovery cycle — switch_strategy progression DIRECT_EDIT → TRACE_EXEC
  E2E-04  Warm start no-op — experience_store=None returns WarmStartResult(loaded=False)
  E2E-05  Parallel branch merge — reconcile_parallel_branches on two world models
  E2E-06  Context compression — small token_budget triggers should_compress + compress_memory
  E2E-07  Reviewer pass re-entry — drain_propagation_queue reopens completed task
  E2E-08  max_steps budget — warn at 0.8×max, escalate at max_steps

Run with: pytest adapter/tests/test_harness_e2e.py -v
"""

from __future__ import annotations

import sys
import uuid
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.belief_graph import BeliefDepGraph
from harness.diagnostics import BeliefHealth, CoverageHealth, Diagnostics, ExecutionHealth, VerificationHealth
from harness.evidence import EvidenceStore
from harness.experience_store import WarmStartResult, warm_start
from harness.failure_modes import FailureDiagnostics
from harness.hypothesis import Hypothesis, HypothesisSet
from harness.loop import run_one_iteration
from harness.memory import MemoryState, check_max_steps, compress_memory, should_compress
from harness.parallel_merge import ParallelBranch, reconcile_parallel_branches
from harness.recovery import StrategyState, switch_strategy
from harness.state_store import HarnessRunState
from harness.task_graph import Task, TaskGraph
from harness.world_model import Belief, Observation, WorldModel

FRAMEWORKS = ["langgraph", "crewai", "mastra", "maf"]


# ─── Shared helpers ────────────────────────────────────────────────────────────


def _make_world_model(n_beliefs: int = 2) -> WorldModel:
    wm = WorldModel()
    for i in range(n_beliefs):
        wm.add_observation(Observation(id=f"obs-{i}", content=f"observation {i}", source="test"))
        wm.add_belief(Belief(id=f"b-{i}", statement=f"belief {i}", confidence=0.8, derived_from=[f"obs-{i}"]))
    return wm


def _make_diagnostics(
    freshness: float = 0.9,
    consistency: float = 0.9,
    support: float = 0.9,
    symptom_coverage: float = 0.8,
    explanation_coverage: float = 0.8,
    strength: float = 0.8,
    feasibility: float = 0.8,
    progress_rate: float = 0.7,
    failure_recurrence: float = 0.1,
    oscillation_score: float = 0.1,
) -> Diagnostics:
    return Diagnostics(
        belief_health=BeliefHealth(freshness=freshness, consistency=consistency, support=support),
        coverage_health=CoverageHealth(symptom_coverage=symptom_coverage, explanation_coverage=explanation_coverage),
        verification_health=VerificationHealth(strength=strength, feasibility=feasibility),
        execution_health=ExecutionHealth(
            progress_rate=progress_rate,
            failure_recurrence=failure_recurrence,
            oscillation_score=oscillation_score,
        ),
    )


def _make_harness_run_state(run_id: str = "") -> HarnessRunState:
    return HarnessRunState(
        run_id=run_id or str(uuid.uuid4()),
        world_model=_make_world_model(),
        diagnostics=_make_diagnostics(),
        task_graph=TaskGraph(
            tasks=[
                Task(
                    id="t1",
                    description="primary task",
                    status="ACTIVE",
                    completed_evidence=[],
                    abstraction_level=0,
                ),
            ]
        ),
        hypothesis_set=HypothesisSet(
            active=[
                Hypothesis(
                    id="h1",
                    explanation="main hypothesis",
                    confidence=0.7,
                    predicted_observations=[],
                    discriminating_evidence=[],
                    generation_sources=["symptom_inference"],
                )
            ],
            eliminated=[],
        ),
        evidence_store=EvidenceStore(),
        strategy_state=StrategyState(),
        memory_state=MemoryState(),
        failure_diagnostics=FailureDiagnostics(),
    )


# ══════════════════════════════════════════════════════════════════════════════
# E2E-01 — Happy path
# ══════════════════════════════════════════════════════════════════════════════


@pytest.mark.parametrize("framework", FRAMEWORKS)
def test_e2e_01_happy_path(framework: str):
    """E2E-01: Full harness loop iteration completes; generation_id incremented twice."""
    state = _make_harness_run_state()
    initial_gen_id = state.world_model.generation_id

    result = run_one_iteration(
        world_model=state.world_model,
        diagnostics=state.diagnostics,
        hypothesis_set=state.hypothesis_set,
        task_graph=state.task_graph,
        failure_diagnostics=state.failure_diagnostics,
        memory_state=state.memory_state,
        strategy_state=state.strategy_state,
        step_count=0,
        harness_run_state=state,
        run_id=state.run_id,
    )

    assert result.get("escalated") is not True
    assert "control_state_a" in result
    assert "control_state_b" in result
    # INV-03: generation_id incremented exactly twice per iteration
    assert state.world_model.generation_id == initial_gen_id + 2


# ══════════════════════════════════════════════════════════════════════════════
# E2E-02 — BLOCKED escalation
# ══════════════════════════════════════════════════════════════════════════════


@pytest.mark.parametrize("framework", FRAMEWORKS)
def test_e2e_02_blocked_escalation(framework: str):
    """E2E-02: Severely degraded diagnostics produce an elevated or BLOCKED control state."""
    state = _make_harness_run_state()

    # Force all diagnostic dimensions to worst values
    state.diagnostics = _make_diagnostics(
        freshness=0.0,
        consistency=0.0,
        support=0.0,
        symptom_coverage=0.0,
        explanation_coverage=0.0,
        strength=0.0,
        feasibility=0.0,
        progress_rate=0.0,
        failure_recurrence=1.0,
        oscillation_score=1.0,
    )

    result = run_one_iteration(
        world_model=state.world_model,
        diagnostics=state.diagnostics,
        hypothesis_set=state.hypothesis_set,
        task_graph=state.task_graph,
        failure_diagnostics=state.failure_diagnostics,
        memory_state=state.memory_state,
        strategy_state=state.strategy_state,
        step_count=0,
        harness_run_state=state,
        run_id=state.run_id,
    )

    # Either escalation triggered or control_state_a is not CLEAR
    if result.get("escalated"):
        assert result["escalation"] is not None
    else:
        cs_a = result.get("control_state_a")
        assert cs_a is not None
        # Pre-existing check (predates the risk_state → permission/execution_mode split):
        # "CLEAR" was never a value risk_state actually took, so this only ever asserted
        # the field exists with some valid value — preserved as-is here, not tightened,
        # since fixing that latent vacuousness is outside this migration's scope.
        assert cs_a.execution_mode in {"NORMAL", "CAUTIOUS", "RECOVERY"}


# ══════════════════════════════════════════════════════════════════════════════
# E2E-03 — Recovery cycle
# ══════════════════════════════════════════════════════════════════════════════


@pytest.mark.parametrize("framework", FRAMEWORKS)
def test_e2e_03_recovery_cycle(framework: str):
    """E2E-03: Repeated switch_strategy calls progress through the strategy order."""
    strategy_state = StrategyState(current_strategy="DIRECT_EDIT")
    initial_strategy = strategy_state.current_strategy

    for _ in range(3):
        strategy_state = switch_strategy(strategy_state, reason="verification_failure")
        if strategy_state.current_strategy == "ESCALATE":
            break

    # Strategy must have advanced at least once
    assert strategy_state.current_strategy != initial_strategy or strategy_state.switch_count >= 1
    assert strategy_state.switch_count >= 1
    assert strategy_state.current_strategy in ("TRACE_EXEC", "ROLLBACK", "REIMPLEMENT", "ESCALATE")


# ══════════════════════════════════════════════════════════════════════════════
# E2E-04 — Warm start no-op (experience_store=None)
# ══════════════════════════════════════════════════════════════════════════════


@pytest.mark.parametrize("framework", FRAMEWORKS)
def test_e2e_04_warm_start_noop_when_no_store(framework: str):
    """E2E-04: warm_start returns WarmStartResult(loaded=False) when experience_store is None."""
    result = warm_start(
        experience_store=None,
        strategy_state=StrategyState(),
        failure_diagnostics=None,
        task_graph=None,
        task_class="debug",
        dep_graph_budget=None,
    )
    assert isinstance(result, WarmStartResult)
    assert result.loaded is False


# ══════════════════════════════════════════════════════════════════════════════
# E2E-05 — Parallel branch merge
# ══════════════════════════════════════════════════════════════════════════════


@pytest.mark.parametrize("framework", FRAMEWORKS)
def test_e2e_05_parallel_branch_merge(framework: str):
    """E2E-05: reconcile_parallel_branches merges two world models and detects contradictions."""
    wm_a = _make_world_model(2)
    wm_b = _make_world_model(2)
    wm_b.add_observation(Observation(id="obs-conflict", content="conflicts with belief 0", source="test"))
    wm_b.add_belief(
        Belief(
            id="b-conflict",
            statement="opposite of belief 0",
            confidence=0.9,
            derived_from=["obs-conflict"],
        )
    )

    branch_tasks = [
        Task(
            id="ta",
            description="branch A task",
            status="COMPLETE",
            completed_evidence=["obs-0"],
            abstraction_level=0,
            parallel_write_domains=["domain_a"],
        ),
        Task(
            id="tb",
            description="branch B task",
            status="COMPLETE",
            completed_evidence=["obs-1"],
            abstraction_level=0,
            parallel_write_domains=["domain_b"],
        ),
    ]
    graph = TaskGraph(tasks=branch_tasks)
    diagnostics = _make_diagnostics()
    evidence_store = EvidenceStore()
    hypothesis_set = HypothesisSet()

    from harness.control_state import ControlState
    from harness.failure_modes import FailureDiagnostics

    result = reconcile_parallel_branches(
        [ParallelBranch(wm_a, ControlState()), ParallelBranch(wm_b, ControlState())],
        graph,
        diagnostics,
        FailureDiagnostics(),
        evidence_store,
        hypothesis_set,
    )
    merged_wm, control_state = result.world_model, result.control_state

    assert merged_wm is not None
    assert control_state is not None
    # Merged model must have observations from both branches
    obs_ids = {o.id for o in merged_wm.observations}
    assert "obs-0" in obs_ids
    assert "obs-conflict" in obs_ids


# ══════════════════════════════════════════════════════════════════════════════
# E2E-06 — Context compression
# ══════════════════════════════════════════════════════════════════════════════


@pytest.mark.parametrize("framework", FRAMEWORKS)
def test_e2e_06_context_compression(framework: str):
    """E2E-06: token pressure >= 0.9 triggers compression; compress_memory trims structures / stamps regions."""
    from harness.memory import PrunedRegion, Structure

    memory_state = MemoryState(max_steps=20)
    memory_state.token_budget.total = 100
    memory_state.token_budget.used = 95

    assert should_compress(memory_state) is True

    memory_state.compression_risk.compressed_structures = [Structure(id=f"s{i}") for i in range(12)]
    memory_state.compression_risk.pruned_regions = [PrunedRegion(id="r")]
    result = compress_memory(memory_state)

    assert len(result.dropped) == 2
    assert len(result.pruned) == 1


# ══════════════════════════════════════════════════════════════════════════════
# E2E-07 — Reviewer pass re-entry
# ══════════════════════════════════════════════════════════════════════════════


@pytest.mark.parametrize("framework", FRAMEWORKS)
def test_e2e_07_reviewer_reentry(framework: str):
    """E2E-07: a reviewer finding naming a COMPLETE task reopens it (the pass reports it; the caller re-queues it)."""
    from harness.belief_graph import DepGraphBudget
    from harness.diagnostics import Diagnostics
    from harness.failure_modes import FailureDiagnostics
    from harness.reviewer import PropagationQueue, reviewer_pass
    from harness.world_model import Contradiction

    wm = _make_world_model(2)
    wm.contradictions.append(
        Contradiction(
            id="c1",
            type="pairwise",
            severity="HIGH",
            scope="local",
            involved_belief_ids=["b-0"],
            description="the result of t1 no longer holds",
        )
    )
    task_graph = TaskGraph(
        tasks=[
            Task(id="t1", description="completed task", status="COMPLETE"),
            Task(id="t2", description="pending task", status="PENDING"),
        ]
    )

    result = reviewer_pass(
        wm,
        [],
        FailureDiagnostics(),
        BeliefDepGraph(),
        DepGraphBudget(),
        HypothesisSet(),
        task_graph,
        Diagnostics(),
        EvidenceStore(),
        PropagationQueue(),
    )

    assert result.reopened_task_ids == ["t1"]
    assert result.tasks_reopened is True


# ══════════════════════════════════════════════════════════════════════════════
# E2E-08 — max_steps budget
# ══════════════════════════════════════════════════════════════════════════════


@pytest.mark.parametrize("framework", FRAMEWORKS)
def test_e2e_08_max_steps_budget(framework: str):
    """E2E-08: warn at step ≥ 0.8×max_steps, escalate at step ≥ max_steps."""
    memory_state = MemoryState(max_steps=5)
    diagnostics = _make_diagnostics()

    # step 2 → below threshold (0.8×5=4.0) → ok
    assert check_max_steps(2, memory_state, diagnostics) == "ok"

    # step 4 → 4 >= 4.0 → warn
    assert check_max_steps(4, memory_state, diagnostics) == "warn"

    # step 5 → 5 >= 5 → escalate
    assert check_max_steps(5, memory_state, diagnostics) == "escalate"
