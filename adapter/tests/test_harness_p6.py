"""
Phase 6 acceptance tests — Recovery & Memory Management.

T01–T15: run without Postgres (pure unit tests).
T16–T18: exercise journal retention and max_steps (no Postgres needed here either;
          the plan notes these "require HarnessRunState persistence" which is tested
          via the serialisation helpers rather than a live DB).

Run with: pytest adapter/tests/test_harness_p6.py -v
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import pytest

# ── Harness imports ───────────────────────────────────────────────────────────

from adapter.harness.progress import (
    STALL_WINDOW,
    cannot_make_progress,
)
from adapter.harness.recovery import (
    STRATEGY_ORDER,
    StrategyState,
    apply_failure_mode_bias,
    get_next_strategy,
    get_strategy_with_experience,
    switch_strategy,
)
from adapter.harness.failure_modes import (
    FailureDiagnostics,
    FailureEntry,
    FailureModeLibrary,
    FailurePattern,
    MatchResult,
    build_default_library,
    normalise_confidence,
)
from adapter.harness.hypothesis import generate_from_failure_library
from adapter.harness.replanning import (
    ReplanScope,
    apply_replan,
    assess_replan_scope,
    diagnose_and_replan,
    rebuild_task_graph,
)
from adapter.harness.memory import (
    CompressionRisk,
    MemoryState,
    apply_retention_policy,
    check_max_steps,
    compress_memory,
    should_compress,
)
from adapter.harness.task_graph import Task, TaskGraph
from adapter.harness.world_model import Belief, Observation, WorldModel
from adapter.harness.diagnostics import Diagnostics


# ── Helpers ───────────────────────────────────────────────────────────────────


def _make_strategy_state(**kwargs: object) -> StrategyState:
    return StrategyState(**kwargs)  # type: ignore[arg-type]


def _make_failure_diagnostics(
    failure_classes: list[str] | None = None,
) -> FailureDiagnostics:
    fd = FailureDiagnostics()
    for fc in (failure_classes or []):
        fd.failure_history.append(FailureEntry(failure_class=fc))
    return fd


def _make_task_graph(n: int = 2) -> TaskGraph:
    tasks = [Task(id=f"t{i}", description=f"task {i}", status="PENDING") for i in range(n)]
    return TaskGraph(tasks=tasks)


# ─────────────────────────────────────────────────────────────────────────────
# P6.1 — cannot_make_progress() (T01–T03)
# ─────────────────────────────────────────────────────────────────────────────


class TestCannotMakeProgress:
    def test_T01_each_proxy_triggers_independently(self) -> None:
        """T01: Each of the four proxies independently returns True while others would be False."""
        tg = _make_task_graph()
        fd_empty = _make_failure_diagnostics()

        # Proxy 1: completion velocity stall
        stalled_history = [5] * STALL_WINDOW
        ss1 = StrategyState(completion_history=stalled_history)
        assert cannot_make_progress(ss1, fd_empty, tg) is True
        assert ss1.stall_reason == "completion_velocity"

        # Proxy 2: strategy looping (switch_count > MAX_SWITCHES, no progress)
        # completion_history has only 2 entries (< STALL_WINDOW) so proxy 1 does not fire;
        # first and last are the same so proxy 2 fires.
        ss2 = StrategyState(switch_count=4, completion_history=[3, 3])
        assert cannot_make_progress(ss2, fd_empty, tg) is True
        assert ss2.stall_reason == "strategy_loop"

        # Proxy 3: failure recurrence
        fd_recurrent = _make_failure_diagnostics(["tool_error", "tool_error", "tool_error"])
        ss3 = StrategyState(completion_history=[1, 2, 3])
        assert cannot_make_progress(ss3, fd_recurrent, tg) is True
        assert ss3.stall_reason == "failure_recurrence"

        # Proxy 4: risk oscillation (6 alternating risk states)
        ss4 = StrategyState(
            completion_history=[1, 2, 3, 4, 5, 6],
            risk_state_history=["NORMAL", "CAUTIOUS", "NORMAL", "CAUTIOUS", "NORMAL", "CAUTIOUS"],
        )
        assert cannot_make_progress(ss4, fd_empty, tg) is True
        assert ss4.stall_reason == "risk_oscillation"

    def test_T02_all_proxies_false_returns_false(self) -> None:
        """T02: All proxies False → cannot_make_progress() is False; stall_reason is empty."""
        tg = _make_task_graph()
        fd = _make_failure_diagnostics(["type_a", "type_b"])
        ss = StrategyState(
            switch_count=1,
            completion_history=[1, 2, 3],
            risk_state_history=["NORMAL", "NORMAL", "NORMAL"],
        )
        result = cannot_make_progress(ss, fd, tg)
        assert result is False
        assert ss.stall_reason == ""

    def test_T03_stall_window_constant_overridable(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """T03: Setting STALL_WINDOW=2 causes proxy 1 to fire after 2 stalled steps."""
        import adapter.harness.progress as prog_module

        monkeypatch.setattr(prog_module, "STALL_WINDOW", 2)

        tg = _make_task_graph()
        fd = _make_failure_diagnostics()
        ss = StrategyState(completion_history=[10, 10])  # 2 identical = stall with STALL_WINDOW=2
        assert prog_module.cannot_make_progress(ss, fd, tg) is True
        assert ss.stall_reason == "completion_velocity"


# ─────────────────────────────────────────────────────────────────────────────
# P6.2 — Recovery strategies (T04–T06)
# ─────────────────────────────────────────────────────────────────────────────


class TestRecoveryStrategies:
    def test_T04_default_strategy_order(self) -> None:
        """T04: Successive switch_strategy() calls follow DIRECT_EDIT → ... → ESCALATE."""
        ss = StrategyState(current_strategy="DIRECT_EDIT")
        expected = ["TRACE_EXEC", "BROADER_SEARCH", "REIMPLEMENT", "MINIMAL_FIX", "ESCALATE", "ESCALATE"]
        for exp in expected:
            ss = switch_strategy(ss, "test")
            assert ss.current_strategy == exp

    def test_T05_advisory_bias_suggestion_not_override(self) -> None:
        """T05: Bias with confidence >= 0.7 returns the affinity strategy as a suggestion;
        the fixed order is still available if the caller ignores the suggestion."""
        ss = StrategyState(current_strategy="DIRECT_EDIT")
        match_result = MatchResult(
            matched=True,
            pattern_name="TOOL_UNAVAILABLE_CASCADE",
            raw_confidence=0.8,
            normalised_confidence=0.8,
            strategy_affinity="REIMPLEMENT",
        )
        suggestion = apply_failure_mode_bias(match_result, ss)
        assert suggestion == "REIMPLEMENT"

        # Fixed order is still returned by get_next_strategy — bias does not replace it
        fixed_next = get_next_strategy(ss)
        assert fixed_next == "TRACE_EXEC"
        assert suggestion != fixed_next  # suggestion differs from fixed progression

    def test_T06_adaptive_strategy_and_fallback(self) -> None:
        """T06: Softmax returns TRACE_EXEC first after DIRECT_EDIT failures;
        experience_store.available=False falls back to fixed order."""
        ss = StrategyState(current_strategy="DIRECT_EDIT")
        failure_class = "tool_error"

        # Mock experience_store with weights favouring TRACE_EXEC
        class _FakeStore:
            available = True
            strategy_weights = {
                "tool_error": {
                    "DIRECT_EDIT": -5.0,
                    "TRACE_EXEC": 5.0,
                    "BROADER_SEARCH": 0.0,
                    "REIMPLEMENT": 0.0,
                    "MINIMAL_FIX": 0.0,
                    "ESCALATE": -5.0,
                }
            }

        result = get_strategy_with_experience(ss, failure_class, _FakeStore())
        assert result == "TRACE_EXEC"

        # Unavailable store falls back transparently
        class _UnavailableStore:
            available = False

        fallback = get_strategy_with_experience(ss, failure_class, _UnavailableStore())
        assert fallback == get_next_strategy(ss)


# ─────────────────────────────────────────────────────────────────────────────
# P6.3 — Failure mode library (T07–T09)
# ─────────────────────────────────────────────────────────────────────────────


class TestFailureModeLibrary:
    def test_T07_normalised_confidence_clamped(self) -> None:
        """T07: normalise_confidence clamps raw > 1.0 to 1.0; match() returns [0,1]."""
        assert normalise_confidence(1.5) == 1.0
        assert normalise_confidence(-0.3) == 0.0
        assert normalise_confidence(0.7) == pytest.approx(0.7)

        # Library with a pattern whose all conditions are satisfied
        lib = FailureModeLibrary([
            FailurePattern(
                name="ALWAYS",
                description="always matches",
                required_conditions=["always"],
                excluded_conditions=[],
                strategy_affinity=None,
                hypothesis_template="always fires",
            )
        ])
        wm = WorldModel()
        wm.beliefs = []
        # Inject context via a belief
        from adapter.harness.world_model import Belief
        import uuid
        b = Belief(
            id=str(uuid.uuid4()),
            statement="this always fires due to the word always being present",
            confidence=0.9,
            derived_from=["src1"],
        )
        wm.beliefs = [b]

        result = lib.match(wm, None, None)
        assert result.matched is True
        assert 0.0 <= result.normalised_confidence <= 1.0

    def test_T08_generate_from_failure_library_sources(self) -> None:
        """T08: generate_from_failure_library() returns Hypothesis with
        generation_sources=["failure_mode_library"] using the matched template."""
        lib = FailureModeLibrary([
            FailurePattern(
                name="TEST_PATTERN",
                description="test",
                required_conditions=["circular", "cycle"],
                excluded_conditions=[],
                strategy_affinity="BROADER_SEARCH",
                hypothesis_template="A circular dependency was detected",
            )
        ])

        wm = WorldModel()
        import uuid
        from adapter.harness.world_model import Belief
        b = Belief(
            id=str(uuid.uuid4()),
            statement="circular dependency and cycle detected in task graph",
            confidence=0.8,
            derived_from=["obs1"],
        )
        wm.beliefs = [b]

        hypotheses = generate_from_failure_library(wm, lib)
        assert len(hypotheses) == 1
        h = hypotheses[0]
        assert "failure_mode_library" in h.generation_sources
        assert h.explanation == "A circular dependency was detected"

    def test_T09_block_mask_not_derived_from_match_result(self) -> None:
        """T09: block_mask in resolve_control_state is derived solely from diagnostic
        sub-dimension thresholds — MatchResult fields do not appear in it."""
        from adapter.harness.control_state import resolve_control_state
        from adapter.harness.diagnostics import Diagnostics
        from adapter.harness.world_model import WorldModel

        wm = WorldModel()
        wm.generation_id = 1
        diag = Diagnostics()

        # High-confidence MatchResult
        high_match = MatchResult(
            matched=True,
            pattern_name="TEST",
            raw_confidence=1.0,
            normalised_confidence=1.0,
            strategy_affinity="REIMPLEMENT",
        )
        fd = FailureDiagnostics(matched_pattern=high_match)

        cs = resolve_control_state(diag, wm, fd, step=1)

        # block_mask entries must only reference diagnostic dimension names
        valid_block_dimensions = {
            "belief_health",
            "coverage_health",
            "verification_health",
            "execution_health",
        }
        for entry in cs.block_mask:
            dim = getattr(entry, "dimension", None)
            if dim is not None:
                assert dim in valid_block_dimensions, (
                    f"block_mask entry references unexpected dimension: {dim!r}"
                )

        # MatchResult fields must not appear in block_mask computation
        match_result_fields = {"matched", "pattern_name", "raw_confidence", "normalised_confidence", "strategy_affinity"}
        for entry in cs.block_mask:
            entry_dict = entry.__dict__ if hasattr(entry, "__dict__") else {}
            assert not match_result_fields.intersection(entry_dict), (
                f"MatchResult field leaked into block_mask entry: {entry_dict}"
            )


# ─────────────────────────────────────────────────────────────────────────────
# P6.4 — Local vs global replanning (T10–T12)
# ─────────────────────────────────────────────────────────────────────────────


class TestReplanning:
    def _make_contradiction(self, scope: str) -> object:
        class _C:
            pass
        c = _C()
        c.scope = scope  # type: ignore[attr-defined]
        return c

    def _make_caller_state(self, criteria: list[str]) -> object:
        class _CS:
            success_criteria = criteria
        return _CS()

    def test_T10_global_scope_rebuilds_all_pending(self) -> None:
        """T10: GLOBAL replan returns all-PENDING tasks; none carry prior status."""
        tg = _make_task_graph(3)
        tg.tasks[0].status = "COMPLETE"
        tg.tasks[1].status = "FAILED"
        tg.tasks[2].status = "ACTIVE"

        wm = WorldModel()
        cs = self._make_caller_state(["criterion A", "criterion B"])
        contradiction = self._make_contradiction("global")

        new_tg = apply_replan("GLOBAL", contradiction, None, tg, wm, cs)
        assert all(t.status == "PENDING" for t in new_tg.tasks)

    def test_T11_local_scope_preserves_unrelated_tasks(self) -> None:
        """T11: LOCAL replan only touches current_task dependents; unrelated tasks keep status."""
        current = Task(id="t_current", description="current", status="ACTIVE")
        dependent = Task(id="t_dep", description="dep", status="ACTIVE", depends_on=["t_current"])
        unrelated = Task(id="t_unrelated", description="unrelated", status="COMPLETE")

        tg = TaskGraph(tasks=[current, dependent, unrelated])
        wm = WorldModel()
        contradiction = self._make_contradiction("local")

        new_tg = apply_replan("LOCAL", contradiction, current, tg, wm, None)

        dep_task = new_tg.get_task("t_dep")
        unrelated_task = new_tg.get_task("t_unrelated")
        assert dep_task is not None and dep_task.status == "PENDING"
        assert unrelated_task is not None and unrelated_task.status == "COMPLETE"

    def test_T12_validate_always_called_after_global_replan(self) -> None:
        """T12: Invalid graph (cycle) from rebuild raises immediately — never returned silently."""
        from adapter.harness import replanning as replan_mod
        import uuid

        original_rebuild = replan_mod.rebuild_task_graph

        def _cyclic_rebuild(wm: object, cs: object) -> TaskGraph:
            t_a = Task(id="a", description="a", status="PENDING", depends_on=["b"])
            t_b = Task(id="b", description="b", status="PENDING", depends_on=["a"])
            return TaskGraph(tasks=[t_a, t_b])

        replan_mod.rebuild_task_graph = _cyclic_rebuild  # type: ignore[assignment]
        try:
            tg = _make_task_graph(1)
            wm = WorldModel()
            cs = self._make_caller_state([])
            contradiction = type("_C", (), {"scope": "global"})()

            with pytest.raises(ValueError, match="invalid"):
                apply_replan("GLOBAL", contradiction, None, tg, wm, cs)
        finally:
            replan_mod.rebuild_task_graph = original_rebuild  # type: ignore[assignment]


# ─────────────────────────────────────────────────────────────────────────────
# P6.5 — Context compression (T13–T15)
# ─────────────────────────────────────────────────────────────────────────────


class TestContextCompression:
    def _make_world_model_with_beliefs(self, n_beliefs: int) -> WorldModel:
        import uuid
        wm = WorldModel()
        for i in range(n_beliefs):
            b = Belief(
                id=str(uuid.uuid4()),
                statement=f"belief {i}",
                confidence=0.8,
                derived_from=[f"obs_{i}"],
            )
            wm.beliefs.append(b)
        return wm

    def test_T13_compressed_vs_pruned_mutually_exclusive(self) -> None:
        """T13: compress_memory separates dropped obs → compressed_structures and
        truncated beliefs → pruned_regions; the two lists are mutually exclusive."""
        import uuid
        wm = WorldModel()

        # Observations not referenced by any belief → will be dropped
        obs_orphan = Observation(id=str(uuid.uuid4()), content="orphan obs", source="test")
        wm.observations = [obs_orphan]

        # 11 beliefs (> MAX_BELIEFS=10) → beliefs region will be pruned
        for i in range(11):
            b = Belief(
                id=str(uuid.uuid4()),
                statement=f"belief {i}",
                confidence=0.8,
                derived_from=["some_src"],
            )
            wm.beliefs.append(b)

        ms = MemoryState()
        dropped, pruned = compress_memory(wm, ms)

        assert len(set(dropped) & set(pruned)) == 0, "dropped and pruned lists must be mutually exclusive"
        assert any("observation:" in d for d in dropped)
        assert "beliefs" in pruned

    def test_T14_completeness_flags_set_false_after_pruning(self) -> None:
        """T14: completeness_flags["beliefs"] is False after beliefs are added to pruned_regions."""
        wm = self._make_world_model_with_beliefs(11)
        ms = MemoryState()
        _, pruned = compress_memory(wm, ms)

        assert "beliefs" in pruned
        assert wm.completeness_flags.get("beliefs") is False

    def test_T15_action_dep_overlap_detects_pruned_regions(self) -> None:
        """T15: action_dep_overlap returns non-empty when action depends on a pruned region."""
        from adapter.harness.execution import action_dep_overlap

        ms = MemoryState()
        ms.compression_risk.pruned_regions.append("beliefs")
        ms.compression_risk.compressed_structures.append("observation:xyz")

        action_pruned = {"required_state_structures": ["beliefs"]}
        action_compressed = {"required_state_structures": ["observation:xyz"]}
        action_unaffected = {"required_state_structures": ["other_region"]}

        assert action_dep_overlap(action_pruned, ms) == ["beliefs"]
        assert action_dep_overlap(action_compressed, ms) == ["observation:xyz"]
        assert action_dep_overlap(action_unaffected, ms) == []


# ─────────────────────────────────────────────────────────────────────────────
# P6.6 — Journal retention + max_steps (T16–T18)
# ─────────────────────────────────────────────────────────────────────────────


class TestJournalAndBudget:
    def _make_journal(self, n_passing: int, n_failures: int, max_verbatim: int = 10) -> tuple[list, dict]:
        journal = []
        for i in range(n_passing):
            journal.append({"action_class": "edit", "outcome": "pass", "step": i, "success": True})
        for i in range(n_failures):
            journal.append({"action_class": "edit", "outcome": "fail", "step": n_passing + i, "success": False})
        policy = {
            "retain_failures_permanently": True,
            "max_passing_verbatim": max_verbatim,
            "compress_older_passing": True,
        }
        return journal, policy

    def test_T16_journal_bounded_after_retention(self) -> None:
        """T16: After 30 passing + 5 failures with max_passing_verbatim=10:
        5 failures verbatim + 10 passing verbatim + 20 compressed passing summaries."""
        journal, policy = self._make_journal(n_passing=30, n_failures=5, max_verbatim=10)
        result = apply_retention_policy(journal, policy)

        failures_in_result = [e for e in result if e.get("outcome") == "fail" or e.get("success") is False]
        verbatim_passing = [
            e for e in result
            if e.get("outcome") == "pass" and e.get("success") is True and "action_class" in e and "step" in e
        ]
        compressed_passing = [
            e for e in result
            if e.get("outcome") == "pass" and e.get("success") is not True
        ]

        assert len(failures_in_result) == 5
        assert len(verbatim_passing) == 10
        assert len(compressed_passing) == 20
        assert len(result) == 35

    def test_T17_check_max_steps_warn_at_80_percent(self) -> None:
        """T17: At 80% of max_steps, check_max_steps returns 'warn' and
        diagnostics.verification_health.feasibility is reduced by 0.1."""
        ms = MemoryState(max_steps=100)
        diag = Diagnostics()
        diag.verification_health.feasibility = 0.9

        result = check_max_steps(80, ms, diag)
        assert result == "warn"
        assert diag.verification_health.feasibility == pytest.approx(0.8)

    def test_T18_check_max_steps_escalate_at_limit(self) -> None:
        """T18: At max_steps, check_max_steps returns 'escalate'.
        The main loop must call escalate(surface_blocker(reason="budget_exhausted"))."""
        ms = MemoryState(max_steps=50)
        diag = Diagnostics()

        result = check_max_steps(50, ms, diag)
        assert result == "escalate"

        # Verify loop wires escalation correctly
        from adapter.harness.world_model import WorldModel
        from adapter.harness.loop import run_one_iteration

        wm = WorldModel()
        wm.generation_id = 0
        ms_small = MemoryState(max_steps=1)
        result_dict = run_one_iteration(
            world_model=wm,
            diagnostics=Diagnostics(),
            hypothesis_set=None,
            task_graph=_make_task_graph(),
            memory_state=ms_small,
            step_count=1,  # == max_steps → escalate
        )
        assert result_dict.get("escalated") is True
        escalation = result_dict.get("escalation", {})
        assert escalation.get("reason") == "budget_exhausted"
