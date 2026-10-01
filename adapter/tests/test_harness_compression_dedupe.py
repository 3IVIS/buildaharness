"""
Above the 90% pressure threshold a compression pass must not re-append pruned regions that are already recorded (twin of
packages/harness src/harness-runtime-token-budget.test.ts).

Run: PYTHONPATH=adapter pytest adapter/tests/test_harness_compression_dedupe.py -q --noconftest
"""

from __future__ import annotations

from harness.memory import MemoryState, PrunedRegion, TokenBudget, compress_memory, record_compression


def _state() -> MemoryState:
    state = MemoryState(token_budget=TokenBudget(total=1000, used=950))
    state.compression_risk.pruned_regions.append(
        PrunedRegion("h1", "eliminated hypothesis", 12, "2026-10-01T00:00:00+00:00")
    )
    return state


def test_recording_the_same_compression_pass_repeatedly_keeps_one_region():
    state = _state()
    for _ in range(3):
        record_compression(state, compress_memory(state))
    assert [r.id for r in state.compression_risk.pruned_regions] == ["h1"]


def test_negative_control_the_pass_itself_does_report_the_recorded_region():
    # Without the dedupe in record_compression, extending with this result is what grew the list.
    state = _state()
    assert [r.id for r in compress_memory(state).pruned] == ["h1"]
