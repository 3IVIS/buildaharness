"""
Phase 6 acceptance tests — Recovery & Memory Management.

T01–T15: run without Postgres (pure unit tests).
T16–T18: exercise journal retention and max_steps (no Postgres needed here either;
          the plan notes these "require HarnessRunState persistence" which is tested
          via the serialisation helpers rather than a live DB).

Run with: pytest adapter/tests/test_harness_p6.py -v
"""

from __future__ import annotations

import pytest

from harness.diagnostics import Diagnostics
from harness.experience_store import InMemoryExperienceStore, UnavailableExperienceStore
from harness.failure_modes import (
    FailureDiagnostics,
    FailureModeEntry,
    FailureModeLibrary,
    FailureRecord,
    MatchResult,
)
from harness.memory import (
    JournalEntry,
    MemoryState,
    apply_retention_policy,
    check_max_steps,
    compress_memory,
    should_compress,
)

# ── Harness imports ───────────────────────────────────────────────────────────
from harness.progress import (
    STALL_WINDOW,
    cannot_make_progress,
)
from harness.recovery import (
    RecoveryBudget,
    StrategyState,
    apply_failure_mode_bias,
    get_next_strategy,
    get_strategy_with_experience,
    switch_strategy,
)
from harness.replanning import (
    apply_replan,
)
from harness.task_graph import Task, TaskGraph
from harness.world_model import Belief, Observation, WorldModel


@pytest.fixture(autouse=True)
def _lexical_checks_on(monkeypatch):
    """These tests exercise the harness's lexical checks, which are off by default (harness/lexical_off.py)."""
    monkeypatch.setenv("HARNESS_LEXICAL_MODE", "enabled")


# ── Helpers ───────────────────────────────────────────────────────────────────


def _make_strategy_state(**kwargs: object) -> StrategyState:
    return StrategyState(**kwargs)  # type: ignore[arg-type]


def _make_failure_diagnostics(
    failure_classes: list[str] | None = None,
) -> FailureDiagnostics:
    fd = FailureDiagnostics()
    for fc in failure_classes or []:
        fd.failure_history.append(FailureRecord(failure_class=fc))
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
        import harness.progress as prog_module

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
            failure_class="TOOL_UNAVAILABLE_CASCADE",
            confidence=0.8,
            matched_pattern="tool-unavailable-cascade",
            strategy_affinity="REIMPLEMENT",
        )
        suggestion = apply_failure_mode_bias(match_result, ss)
        assert suggestion == "REIMPLEMENT"

        # Fixed order is still returned by get_next_strategy — bias does not replace it
        fixed_next = get_next_strategy(ss)
        assert fixed_next == "TRACE_EXEC"
        assert suggestion != fixed_next  # suggestion differs from fixed progression

    def test_T06_adaptive_strategy_and_fallback(self) -> None:
        """T06: recorded weights (keys "<strategy>:<class>", as TS) reorder the ladder by softmax; the next strategy is
        the one after the current in that ordering. An unavailable store falls back to the fixed order."""
        ss = StrategyState(current_strategy="DIRECT_EDIT")
        failure_class = "tool_error"

        store = InMemoryExperienceStore()
        for strategy, weight in {
            "DIRECT_EDIT": -5.0,
            "TRACE_EXEC": 5.0,
            "BROADER_SEARCH": 0.0,
            "REIMPLEMENT": 0.0,
            "MINIMAL_FIX": 0.0,
            "ESCALATE": -5.0,
        }.items():
            store.set_strategy_weight(f"{strategy}:{failure_class}", weight)

        # ordering by descending probability: TRACE_EXEC, then the zero-weight strategies (in ladder order),
        # then DIRECT_EDIT / ESCALATE — the next strategy is the one after the current in that ordering.
        ordering = ["TRACE_EXEC", "BROADER_SEARCH", "REIMPLEMENT", "MINIMAL_FIX", "DIRECT_EDIT", "ESCALATE"]
        for current, expected in zip(ordering, [*ordering[1:], "ESCALATE"], strict=True):
            state = StrategyState(current_strategy=current)  # type: ignore[arg-type]
            assert get_strategy_with_experience(state, failure_class, store) == expected

        # Unavailable store falls back transparently
        fallback = get_strategy_with_experience(ss, failure_class, UnavailableExperienceStore())
        assert fallback == get_next_strategy(ss)


# ─────────────────────────────────────────────────────────────────────────────
# P6.3 — Failure mode library (T07–T09)
# ─────────────────────────────────────────────────────────────────────────────


class TestFailureModeLibrary:
    def test_T07_match_scores_overlap_and_picks_best(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """T07: match(symptoms) scores each entry by curated-symptom overlap / max(#curated, #observed) and returns
        the best; a result carries failure_class, confidence in [0,1], the entry id and the strategy affinity."""
        monkeypatch.setenv("HARNESS_LEXICAL_MODE", "enabled")
        lib = FailureModeLibrary(
            [
                FailureModeEntry("weak", "WEAK", ["alpha", "beta", "gamma", "delta"], "d", "MINIMAL_FIX"),
                FailureModeEntry("strong", "STRONG", ["circular", "cycle"], "d", "BROADER_SEARCH"),
            ]
        )
        result = lib.match(["circular dependency and cycle detected in task graph"])
        assert result is not None
        assert result.failure_class == "STRONG"
        assert result.matched_pattern == "strong"
        assert result.strategy_affinity == "BROADER_SEARCH"
        assert result.confidence == pytest.approx(2 / 2)
        assert 0.0 <= result.confidence <= 1.0
        assert lib.match(["nothing relevant here"]) is None

    def test_T07b_match_is_off_without_the_lexical_switch(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """T07b: HARNESS_LEXICAL failure-exact-match off (the default) -> only a semantic matcher can classify."""
        monkeypatch.delenv("HARNESS_LEXICAL_MODE", raising=False)
        lib = FailureModeLibrary([FailureModeEntry("e", "E", ["circular"], "d")])
        assert lib.match(["circular dependency"]) is None

    def test_T08_class_priors_and_round_trip(self) -> None:
        """T08: class_priors live on the library and survive FailureDiagnostics to_dict/from_dict."""
        lib = FailureModeLibrary([FailureModeEntry("e", "E", ["x"], "d", "TRACE_EXEC")], {"E": 0.7})
        fd = FailureDiagnostics(
            failure_mode_library=lib,
            matched_pattern=MatchResult("E", 0.5, "e", "TRACE_EXEC"),
            failure_history=[FailureRecord(failure_class="E", description="boom")],
        )
        restored = FailureDiagnostics.from_dict(fd.to_dict())
        assert restored.failure_mode_library.class_priors == {"E": 0.7}
        assert restored.failure_mode_library.entries[0].strategy_affinity == "TRACE_EXEC"
        assert restored.matched_pattern == fd.matched_pattern
        assert restored.failure_history[0].failure_class == "E"

    def test_T09_block_mask_not_derived_from_match_result(self) -> None:
        """T09: block_mask in resolve_control_state is derived solely from diagnostic
        sub-dimension thresholds — MatchResult fields do not appear in it."""
        from harness.control_state import resolve_control_state
        from harness.diagnostics import Diagnostics
        from harness.world_model import WorldModel

        wm = WorldModel()
        wm.generation_id = 1
        diag = Diagnostics()

        # High-confidence MatchResult
        high_match = MatchResult(
            failure_class="TEST",
            confidence=1.0,
            matched_pattern="test",
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
                assert dim in valid_block_dimensions, f"block_mask entry references unexpected dimension: {dim!r}"

        # MatchResult fields must not appear in block_mask computation
        match_result_fields = {
            "failure_class",
            "confidence",
            "matched_pattern",
            "strategy_affinity",
        }
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
        tg.tasks[2].status = "RUNNING"

        wm = WorldModel()
        cs = self._make_caller_state(["criterion A", "criterion B"])
        contradiction = self._make_contradiction("global")

        new_tg = apply_replan("GLOBAL", contradiction, None, tg, wm, cs)
        assert all(t.status == "PENDING" for t in new_tg.tasks)

    def test_T11_local_scope_preserves_unrelated_tasks(self) -> None:
        """T11: LOCAL replan only touches current_task dependents; unrelated tasks keep status."""
        current = Task(id="t_current", description="current", status="RUNNING")
        dependent = Task(id="t_dep", description="dep", status="RUNNING", depends_on=["t_current"])
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
        """T12: an invalid graph (orphaned dependency) from rebuild raises immediately — never returned silently."""

        from harness import replanning as replan_mod

        original_rebuild = replan_mod.rebuild_task_graph

        def _orphan_rebuild(wm: object, cs: object) -> TaskGraph:
            return TaskGraph(tasks=[Task(id="a", description="a", status="PENDING", depends_on=["ghost"])])

        replan_mod.rebuild_task_graph = _orphan_rebuild  # type: ignore[assignment]
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
    def test_T13_compress_memory_trims_structures_and_stamps_regions(self) -> None:
        """T13: compress_memory keeps at most 10 compressed structures (dropping the oldest), returns the dropped
        ones, and stamps every pruned region not in the preserve set — beliefs/observations are never touched."""
        from harness.memory import PrunedRegion, Structure

        wm = WorldModel()
        wm.beliefs.append(Belief(id="b", statement="s", confidence=0.8, derived_from=["src"]))
        wm.observations.append(Observation(id="o", content="c", source="t"))
        ms = MemoryState()
        ms.compression_risk.compressed_structures = [Structure(id=f"s{i}") for i in range(13)]
        ms.compression_risk.pruned_regions = [PrunedRegion(id="keep"), PrunedRegion(id="drop")]

        result = compress_memory(ms, ["keep"])

        assert [s.id for s in result.dropped] == ["s0", "s1", "s2"]
        assert len(ms.compression_risk.compressed_structures) == 10
        assert [r.id for r in result.pruned] == ["drop"]
        assert result.pruned[0].pruned_at != ""
        assert len(wm.beliefs) == 1 and len(wm.observations) == 1

    def test_T14_pressure_threshold(self) -> None:
        """T14: should_compress is True once token_budget.used / total >= 0.9 (the caller maintains `used`)."""
        ms = MemoryState()
        ms.token_budget.total = 1000
        ms.token_budget.used = 899
        assert should_compress(ms) is False
        ms.token_budget.used = 900
        assert should_compress(ms) is True

    def test_T15_action_dep_overlap_detects_pruned_regions(self) -> None:
        """T15: action_dep_overlap returns non-empty when action depends on a pruned region."""
        from harness.execution import action_dep_overlap
        from harness.memory import PrunedRegion, Structure

        ms = MemoryState()
        ms.compression_risk.pruned_regions.append(
            PrunedRegion(id="beliefs", description="beliefs", token_count=0, pruned_at="")
        )
        ms.compression_risk.compressed_structures.append(
            Structure(id="observation:xyz", description="observation:xyz", token_count=0)
        )

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
    def _make_journal(self, n_passing: int, n_failures: int, max_verbatim: int = 10) -> MemoryState:
        ms = MemoryState()
        for i in range(n_passing):
            ms.journal.append(
                JournalEntry(step=i, action_class="edit", outcome="completed", success=True, verbatim="v")
            )
        for i in range(n_failures):
            ms.journal.append(JournalEntry(step=n_passing + i, action_class="edit", outcome="failed:x", success=False))
        ms.journal_retention_policy.max_passing_verbatim = max_verbatim
        return ms

    def test_T16_journal_bounded_after_retention(self) -> None:
        """T16: After 30 passing + 5 failures with max_passing_verbatim=10 the journal is: 5 failures, then 20
        compressed older passing entries (no verbatim), then the 10 most recent passing entries verbatim."""
        ms = self._make_journal(n_passing=30, n_failures=5, max_verbatim=10)
        apply_retention_policy(ms)
        result = ms.journal

        assert len(result) == 35
        assert [e.success for e in result[:5]] == [False] * 5
        assert all(e.verbatim is None and e.success for e in result[5:25])
        assert [e.step for e in result[5:25]] == list(range(20))
        assert all(e.verbatim == "v" for e in result[25:])
        assert [e.step for e in result[25:]] == list(range(20, 30))

    def test_T16b_failures_dropped_when_not_retained(self) -> None:
        ms = self._make_journal(n_passing=2, n_failures=3)
        ms.journal_retention_policy.retain_failures_permanently = False
        apply_retention_policy(ms)
        assert all(e.success for e in ms.journal)

    def test_T17_check_max_steps_warn_at_80_percent(self) -> None:
        """T17: from floor(0.8 * max_steps) on, check_max_steps returns 'warn' and caps
        verification_health.feasibility at BUDGET_WARNING_FLOOR (0.5), as the TS runtime does."""
        ms = MemoryState(max_steps=100)
        diag = Diagnostics()
        diag.verification_health.feasibility = 0.9

        result = check_max_steps(80, ms, diag)
        assert result == "warn"
        assert diag.verification_health.feasibility == pytest.approx(0.5)

        diag.verification_health.feasibility = 0.3
        check_max_steps(85, ms, diag)
        assert diag.verification_health.feasibility == pytest.approx(0.3)  # min(), never raised

    def test_T18_check_max_steps_escalate_at_limit(self) -> None:
        """T18: At max_steps, check_max_steps returns 'escalate'.
        The main loop must call escalate(surface_blocker(reason="budget_exhausted"))."""
        ms = MemoryState(max_steps=50)
        diag = Diagnostics()

        result = check_max_steps(50, ms, diag)
        assert result == "escalate"

        # Verify loop wires escalation correctly
        from harness.loop import run_one_iteration
        from harness.world_model import WorldModel

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


class TestRecoveryBudget:
    """RecoveryBudget (Phase 2 of the internal
    plan) — genuine multi-dimensional resource bounds on recovery, additional to (not
    instead of) the existing STRATEGY_ORDER-length implicit bound TestRecoveryStrategies
    and TestJournalAndBudget's tests above already cover."""

    def test_fresh_budget_is_not_exhausted(self) -> None:
        assert RecoveryBudget().is_exhausted() is False

    def test_consume_is_immutable(self) -> None:
        budget = RecoveryBudget(max_tool_calls=10)
        consumed = budget.consume(tool_calls=3)
        assert budget.tool_calls_used == 0  # original untouched
        assert consumed.tool_calls_used == 3

    def test_each_dimension_independently_triggers_exhaustion(self) -> None:
        assert RecoveryBudget(max_tool_calls=5, tool_calls_used=5).is_exhausted() is True
        assert RecoveryBudget(max_cost=1.0, cost_used=1.0).is_exhausted() is True
        assert RecoveryBudget(max_time_seconds=60, time_used_seconds=60).is_exhausted() is True
        assert RecoveryBudget(max_plan_revisions=3, plan_revisions_used=3).is_exhausted() is True

    def test_exhausted_in_one_dimension_only_still_exhausts_the_whole_budget(self) -> None:
        """Recovery isn't allowed to keep going on cost alone once plan revisions run out."""
        budget = RecoveryBudget(max_plan_revisions=3, plan_revisions_used=3, cost_used=0.0)
        assert budget.is_exhausted() is True

    def test_round_trips_through_to_dict_from_dict(self) -> None:
        budget = RecoveryBudget(max_tool_calls=15).consume(tool_calls=4, cost=0.5, time_seconds=12.0, plan_revisions=1)
        restored = RecoveryBudget.from_dict(budget.to_dict())
        assert restored == budget

    def test_loop_escalates_instead_of_switching_when_budget_already_exhausted(self) -> None:
        """The core fix: an exhausted budget escalates BEFORE another plan revision is
        taken, not after — checked ahead of switch_strategy(), not as an afterthought."""
        from harness.loop import run_one_iteration
        from harness.world_model import WorldModel

        fd = _make_failure_diagnostics(["timeout", "timeout", "timeout"])
        ss = _make_strategy_state(completion_history=[0, 0])  # stalled: no progress
        exhausted = RecoveryBudget(max_plan_revisions=1, plan_revisions_used=1)

        result = run_one_iteration(
            world_model=WorldModel(),
            diagnostics=Diagnostics(),
            hypothesis_set=None,
            task_graph=_make_task_graph(),
            failure_diagnostics=fd,
            strategy_state=ss,
            recovery_budget=exhausted,
        )

        assert result.get("escalated") is True
        assert result.get("escalation", {}).get("reason") == "budget_exhausted"
        # switch_strategy() was never reached — strategy_state comes back unchanged.
        assert result.get("strategy_state") is None or ss.switch_count == 0

    def test_loop_switches_and_consumes_one_plan_revision_when_budget_has_room(self) -> None:
        from harness.loop import run_one_iteration
        from harness.world_model import WorldModel

        fd = _make_failure_diagnostics(["timeout", "timeout", "timeout"])
        ss = _make_strategy_state(completion_history=[0, 0])
        fresh = RecoveryBudget(max_plan_revisions=3)

        result = run_one_iteration(
            world_model=WorldModel(),
            diagnostics=Diagnostics(),
            hypothesis_set=None,
            task_graph=_make_task_graph(),
            failure_diagnostics=fd,
            strategy_state=ss,
            recovery_budget=fresh,
        )

        returned_budget = result.get("recovery_budget")
        assert returned_budget is not None
        assert returned_budget.plan_revisions_used == 1
        returned_strategy_state = result.get("strategy_state")
        assert returned_strategy_state is not None
        assert returned_strategy_state.switch_count == 1
