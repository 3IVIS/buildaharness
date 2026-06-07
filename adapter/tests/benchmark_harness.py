"""
Phase 11 — Harness loop performance benchmarks (P11.5).

Benchmarks harness loop overhead against a framework-only baseline.
Target: <500ms added overhead per iteration.

Operations benchmarked:
  - Full harness loop (run_one_iteration) vs. baseline no-op
  - generate_hypotheses()        target <200ms
  - propagate_beliefs()          target <100ms
  - detect_contradictions()
  - resolve_control_state()

Run with: python adapter/tests/benchmark_harness.py
Or with pytest-benchmark: pytest adapter/tests/benchmark_harness.py -v --benchmark-only

Results are printed as a summary table. The full report is in docs/harness_benchmark_report.md.
"""

from __future__ import annotations

import statistics
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.belief_graph import BeliefDepGraph
from harness.contradiction import detect_contradictions
from harness.control_state import resolve_control_state
from harness.diagnostics import BeliefHealth, CoverageHealth, Diagnostics, ExecutionHealth, VerificationHealth
from harness.evidence import Evidence, EvidenceStore
from harness.failure_modes import FailureDiagnostics
from harness.hypothesis import HypothesisSet, generate_hypotheses
from harness.loop import run_one_iteration
from harness.memory import MemoryState
from harness.recovery import StrategyState
from harness.state_store import HarnessRunState
from harness.task_graph import Task, TaskGraph
from harness.world_model import Belief, Observation, WorldModel

N_RUNS = 50
_MS = 1000.0


# ─── Helpers ──────────────────────────────────────────────────────────────────


def _make_world_model(n: int = 5) -> WorldModel:
    wm = WorldModel()
    for i in range(n):
        wm.add_observation(Observation(id=f"obs-{i}", content=f"observation content {i}", source="test"))
        wm.add_belief(Belief(id=f"b-{i}", statement=f"belief {i}", confidence=0.8, derived_from=[f"obs-{i}"]))
    return wm


def _make_diagnostics() -> Diagnostics:
    return Diagnostics(
        belief_health=BeliefHealth(freshness=0.9, consistency=0.9, support=0.9),
        coverage_health=CoverageHealth(symptom_coverage=0.8, explanation_coverage=0.8),
        verification_health=VerificationHealth(strength=0.8, feasibility=0.8),
        execution_health=ExecutionHealth(progress_rate=0.7, failure_recurrence=0.1, oscillation_score=0.1),
    )


def _make_run_state() -> HarnessRunState:
    return HarnessRunState(
        run_id=str(uuid.uuid4()),
        world_model=_make_world_model(),
        diagnostics=_make_diagnostics(),
        task_graph=TaskGraph(tasks=[
            Task(id="t1", description="task", status="ACTIVE", completed_evidence=[], abstraction_level=0),
        ]),
        hypothesis_set=HypothesisSet(active=[], eliminated=[]),
        evidence_store=EvidenceStore(),
        strategy_state=StrategyState(),
        memory_state=MemoryState(),
        failure_diagnostics=FailureDiagnostics(),
    )


def _timeit(fn, n: int = N_RUNS) -> tuple[float, float, float]:
    """Run fn() n times and return (mean_ms, min_ms, max_ms)."""
    times = []
    for _ in range(n):
        t0 = time.perf_counter()
        fn()
        times.append((time.perf_counter() - t0) * _MS)
    return statistics.mean(times), min(times), max(times)


# ─── Baseline (no harness) ────────────────────────────────────────────────────


def benchmark_baseline_noop() -> tuple[float, float, float]:
    """Baseline: minimal Python work (state creation + dict return)."""
    def noop():
        wm = WorldModel()
        return {"world_model": wm}
    return _timeit(noop)


# ─── Full harness loop ────────────────────────────────────────────────────────


def benchmark_full_loop() -> tuple[float, float, float]:
    """Full run_one_iteration() — the primary overhead metric."""
    def one_iteration():
        state = _make_run_state()
        return run_one_iteration(
            world_model=state.world_model,
            diagnostics=state.diagnostics,
            hypothesis_set=state.hypothesis_set,
            task_graph=state.task_graph,
            failure_diagnostics=state.failure_diagnostics,
            memory_state=state.memory_state,
            strategy_state=state.strategy_state,
            step_count=0,
        )
    return _timeit(one_iteration)


# ─── Individual operations ────────────────────────────────────────────────────


def benchmark_generate_hypotheses() -> tuple[float, float, float]:
    """generate_hypotheses(world_model, evidence_store) — target <200ms."""
    wm = _make_world_model(10)
    store = EvidenceStore()
    for i in range(5):
        store.append(Evidence(
            id=str(uuid.uuid4()),
            obs=f"observation {i}",
            reliability="HIGH",
            source="test",
            evidence_type="OBSERVATION",
            freshness=1.0,
        ))

    def gen():
        return generate_hypotheses(wm, store)
    return _timeit(gen)


def benchmark_propagate_beliefs() -> tuple[float, float, float]:
    """propagate_beliefs(dep_graph, budget, world_model) — target <100ms."""
    from harness.belief_graph import DepGraphBudget, propagate_beliefs

    wm = _make_world_model(10)
    dep_graph = BeliefDepGraph()
    budget = DepGraphBudget()

    def prop():
        return propagate_beliefs(dep_graph, budget, wm)
    return _timeit(prop)


def benchmark_detect_contradictions() -> tuple[float, float, float]:
    """detect_contradictions(world_model, evidence_store, hypothesis_set)."""
    wm = _make_world_model(5)
    store = EvidenceStore()
    hs = HypothesisSet(active=[], eliminated=[])

    def det():
        return detect_contradictions(wm, store, hs)
    return _timeit(det)


def benchmark_resolve_control_state() -> tuple[float, float, float]:
    """resolve_control_state(diagnostics, world_model)."""
    wm = _make_world_model(5)
    diag = _make_diagnostics()

    def res():
        return resolve_control_state(diag, wm)
    return _timeit(res)


# ─── Report ───────────────────────────────────────────────────────────────────


def _fmt(mean: float, min_: float, max_: float, target: float | None = None) -> str:
    status = ""
    if target is not None:
        status = " ✓" if mean < target else " ✗ (over budget)"
    return f"mean={mean:.2f}ms  min={min_:.2f}ms  max={max_:.2f}ms{status}"


def run_benchmarks() -> dict[str, tuple[float, float, float]]:
    print(f"\n{'─' * 60}")
    print(f"  Its Harness — Performance Benchmarks  (n={N_RUNS} runs)")
    print(f"{'─' * 60}")

    results = {}

    print("\n[Baseline]")
    results["baseline_noop"] = benchmark_baseline_noop()
    print(f"  noop baseline:          {_fmt(*results['baseline_noop'])}")

    print("\n[Full harness loop]")
    results["full_loop"] = benchmark_full_loop()
    overhead = results["full_loop"][0] - results["baseline_noop"][0]
    print(f"  run_one_iteration:      {_fmt(*results['full_loop'])}")
    print(f"  loop overhead vs noop:  {overhead:.2f}ms {'✓ (<500ms)' if overhead < 500 else '✗ (>500ms)'}")

    print("\n[Individual operations]")
    results["generate_hypotheses"] = benchmark_generate_hypotheses()
    print(f"  generate_hypotheses:    {_fmt(*results['generate_hypotheses'], target=200)}")

    results["propagate_beliefs"] = benchmark_propagate_beliefs()
    print(f"  propagate_beliefs:      {_fmt(*results['propagate_beliefs'], target=100)}")

    results["detect_contradictions"] = benchmark_detect_contradictions()
    print(f"  detect_contradictions:  {_fmt(*results['detect_contradictions'])}")

    results["resolve_control_state"] = benchmark_resolve_control_state()
    print(f"  resolve_control_state:  {_fmt(*results['resolve_control_state'])}")

    print(f"\n{'─' * 60}")

    # Identify top-3 bottlenecks (excluding baseline)
    ops = {k: v[0] for k, v in results.items() if k != "baseline_noop"}
    top3 = sorted(ops.items(), key=lambda x: x[1], reverse=True)[:3]
    print("\nTop-3 bottlenecks:")
    for rank, (name, mean_ms) in enumerate(top3, 1):
        print(f"  {rank}. {name}: {mean_ms:.2f}ms")

    print(f"\n{'─' * 60}\n")
    return results


if __name__ == "__main__":
    run_benchmarks()
