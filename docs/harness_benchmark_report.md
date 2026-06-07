# Harness Loop Performance Benchmark Report

**Phase:** P11.5  
**Date:** 2026-06-07  
**Python:** 3.12  
**Runs per benchmark:** 50  

## Methodology

Benchmarks are pure Python, infrastructure-free (no DB, no network, no LLM calls).
Each function is called 50 times with `time.perf_counter()` wrapping; mean, min, and max
are reported in milliseconds. The baseline is a no-op that only constructs an empty
`WorldModel` and returns a dict — this isolates Python interpreter overhead from harness logic.

The primary SLA is **< 500 ms added loop overhead per iteration** (loop mean minus baseline mean).

Run with:

```
PYTHONPATH=adapter python3.12 adapter/tests/benchmark_harness.py
```

Or with pytest-benchmark:

```
PYTHONPATH=adapter python3.12 -m pytest adapter/tests/benchmark_harness.py -v --benchmark-only
```

## Results

| Operation | Mean (ms) | Min (ms) | Max (ms) | Target | Status |
|---|---|---|---|---|---|
| noop baseline | 0.00 | 0.00 | 0.10 | — | — |
| **run_one_iteration** (full loop) | **0.11** | **0.10** | **0.24** | — | — |
| loop overhead vs noop | **0.11** | — | — | < 500 ms | **✓ PASS** |
| generate_hypotheses | 0.23 | 0.21 | 0.31 | < 200 ms | **✓ PASS** |
| propagate_beliefs | 0.00 | 0.00 | 0.00 | < 100 ms | **✓ PASS** |
| detect_contradictions | 0.04 | 0.04 | 0.07 | — | — |
| resolve_control_state | 0.01 | 0.01 | 0.05 | — | — |

## Top-3 Bottlenecks

1. **generate_hypotheses** — 0.23 ms mean. Iterates world-model observations and failure-mode library to generate candidate hypotheses. Dominant cost is Python object construction for each hypothesis.
2. **run_one_iteration (full loop)** — 0.11 ms mean. Orchestrates generate→propagate→detect→resolve in a single synchronous call. All sub-costs above are included here.
3. **detect_contradictions** — 0.04 ms mean. Pairwise comparison across beliefs and evidence; cost is O(n²) in belief count. Acceptable for test world-models of 5–10 beliefs.

## Analysis

All targets are met with large margins:

- **Loop overhead**: 0.11 ms vs 500 ms target — **~4500× headroom**. The harness adds negligible cost per iteration relative to any real LLM inference latency (typically 500–5000 ms).
- **generate_hypotheses**: 0.23 ms vs 200 ms target — **~870× headroom**. Scales with the number of failure library entries; the default library has ~15 patterns.
- **propagate_beliefs**: < 0.01 ms vs 100 ms target. The propagation queue is empty in the benchmark fixture, so this reflects the function call overhead only.

## Accepted Trade-offs

- Benchmarks use small world models (5–10 beliefs, 5 evidence items). In production runs with large belief graphs (100+ nodes), `detect_contradictions` and `generate_hypotheses` will scale super-linearly. The benchmark suite documents best-case latency, not worst-case.
- `propagate_beliefs` reports near-zero time because the benchmark fixture starts with an empty propagation queue. A saturated queue with 50+ updates would show meaningful latency; that scenario is left to integration-level load tests.
- The benchmarks do not include Postgres I/O (`state_store.save`/`load`) or LLM API calls, which dominate real-world wall-clock time. Harness-only overhead is the correct isolation target.
