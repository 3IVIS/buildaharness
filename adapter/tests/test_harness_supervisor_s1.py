"""
S1 of plans/harness_trajectory_supervisor_plan.html — the supervisor directive is
decided by the async driver on the cannot_make_progress() edge and applied inside
run_one_iteration()'s stall branch (REDIRECT_STRATEGY / REFRAME_PLAN / CONTINUE;
ASK_USER coerced to CONTINUE until S3 — GATHER_EVIDENCE wired in S4, ABORT in S6).

Covers INV-20 (one-shot), INV-21 (no resolver/belief mutation), INV-22 (stall-edge
only), the decide() fail-safe matrix, budget honesty, and the flag-OFF no-op path.

Run: pytest adapter/tests/test_harness_supervisor_s1.py -q --noconftest
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.diagnostics import (
    BeliefHealth,
    CoverageHealth,
    Diagnostics,
    ExecutionHealth,
    VerificationHealth,
)
from harness.failure_modes import FailureDiagnostics, FailureEntry
from harness.hypothesis import HypothesisSet
from harness.loop import run_one_iteration
from harness.memory import MemoryState
from harness.recovery import STRATEGY_ORDER, RecoveryBudget, StrategyState
from harness.supervisor import SupervisorDirective, decide_supervisor_directive
from harness.task_graph import Task, TaskGraph
from harness.world_model import Belief, Observation, WorldModel

STALL_HISTORY = [0, 0, 0, 0, 0, 0]  # proxy 1: no completion advance over STALL_WINDOW


def _healthy_diagnostics() -> Diagnostics:
    return Diagnostics(
        belief_health=BeliefHealth(freshness=0.9, consistency=0.9, support=0.9),
        coverage_health=CoverageHealth(symptom_coverage=0.9, explanation_coverage=0.9),
        verification_health=VerificationHealth(strength=0.9, feasibility=0.9),
        execution_health=ExecutionHealth(progress_rate=0.9, failure_recurrence=0.1, oscillation_score=0.1),
    )


class _CallerState:
    def __init__(self, success_criteria: list[str]):
        self.success_criteria = success_criteria
        self.constraints_changed = False


def _run(directive, *, stalled=True, caller_state=None, recovery_budget=None, strategy_state=None, monkeypatch=None):
    if monkeypatch is not None:
        monkeypatch.setenv("HARNESS_TRAJECTORY_SUPERVISOR", "1")
    wm = WorldModel()
    wm.add_observation(Observation(id="o0", content="obs", source="test"))
    wm.add_belief(Belief(id="b0", statement="belief 0", confidence=0.8, derived_from=["o0"]))
    ss = strategy_state or StrategyState(completion_history=list(STALL_HISTORY) if stalled else [1, 2, 3])
    tg = TaskGraph(tasks=[Task(id="t1", description="primary", status="ACTIVE", abstraction_level=0)])
    result = run_one_iteration(
        world_model=wm,
        diagnostics=_healthy_diagnostics(),
        hypothesis_set=HypothesisSet(active=[], eliminated=[]),
        task_graph=tg,
        failure_diagnostics=FailureDiagnostics(),
        memory_state=MemoryState(),
        strategy_state=ss,
        caller_state=caller_state,
        recovery_budget=recovery_budget,
        step_count=0,
        supervisor_directive=directive,
    )
    return result, result.get("strategy_state", ss), result.get("task_graph", tg), wm


# ── flag OFF — directive is inert ────────────────────────────────────────────


def test_flag_off_ignores_directive(monkeypatch):
    monkeypatch.delenv("HARNESS_TRAJECTORY_SUPERVISOR", raising=False)
    d = SupervisorDirective(action="REDIRECT_STRATEGY", rationale="pivot", strategy_hint="REIMPLEMENT")
    _r, ss, _tg, _wm = _run(d, stalled=True)
    # Normal ladder: DIRECT_EDIT → TRACE_EXEC, not the REIMPLEMENT hint.
    assert ss.current_strategy == "TRACE_EXEC"


def test_none_directive_matches_baseline_ladder(monkeypatch):
    monkeypatch.setenv("HARNESS_TRAJECTORY_SUPERVISOR", "1")
    _r, ss, _tg, _wm = _run(None, stalled=True)
    assert ss.current_strategy == "TRACE_EXEC"
    assert ss.switch_count == 1


# ── REDIRECT_STRATEGY ───────────────────────────────────────────────────────


def test_redirect_strategy_applies_hint(monkeypatch):
    d = SupervisorDirective(
        action="REDIRECT_STRATEGY", rationale="tracing will surface it", strategy_hint="REIMPLEMENT"
    )
    _r, ss, _tg, _wm = _run(d, monkeypatch=monkeypatch)
    assert ss.current_strategy == "REIMPLEMENT"
    assert ss.switch_count == 1
    assert any("supervisor:REDIRECT_STRATEGY" in t for t in ss.switch_triggers)


def test_redirect_with_unknown_hint_falls_through(monkeypatch):
    d = SupervisorDirective(action="REDIRECT_STRATEGY", rationale="x", strategy_hint="NOT_A_STRATEGY")
    # from_dict would coerce this, but a hand-built directive with a bad hint must
    # still fall through safely to the normal ladder.
    _r, ss, _tg, _wm = _run(d, monkeypatch=monkeypatch)
    assert ss.current_strategy == "TRACE_EXEC"


# ── CONTINUE + not-yet-built actions ────────────────────────────────────────


def test_continue_uses_normal_ladder(monkeypatch):
    d = SupervisorDirective.cont("let the ladder run")
    _r, ss, _tg, _wm = _run(d, monkeypatch=monkeypatch)
    assert ss.current_strategy == "TRACE_EXEC"


# GATHER_EVIDENCE moved out of this list in S4, ABORT in S6 — both are now built
# actions (see test_harness_supervisor_s4.py / test_harness_supervisor_s6.py).
# Only ASK_USER still coerces to CONTINUE until S3's host wiring lands.
@pytest.mark.parametrize("action", ["ASK_USER"])
def test_unbuilt_actions_coerce_to_continue(monkeypatch, action):
    kwargs = {"rationale": "later"}
    if action == "ASK_USER":
        from harness.supervisor import UserQuestion

        kwargs["question"] = UserQuestion(question="which env?")
    d = SupervisorDirective(action=action, **kwargs)
    _r, ss, _tg, _wm = _run(d, monkeypatch=monkeypatch)
    assert ss.current_strategy == "TRACE_EXEC"
    assert any(f"{action}->CONTINUE" in t for t in ss.switch_triggers)


# ── REFRAME_PLAN ───────────────────────────────────────────────────────────


def test_reframe_plan_rebuilds_graph_from_note(monkeypatch):
    cs = _CallerState(success_criteria=["ship the widget"])
    d = SupervisorDirective(action="REFRAME_PLAN", rationale="wrong decomposition", plan_note="do auth before storage")
    _r, ss, tg, _wm = _run(d, caller_state=cs, monkeypatch=monkeypatch)
    descriptions = " ".join(t.description for t in tg.tasks)
    assert "do auth before storage" in descriptions
    assert "ship the widget" in descriptions
    # REFRAME does not advance the strategy ladder.
    assert ss.current_strategy == "DIRECT_EDIT"
    assert ss.switch_count == 0
    assert any("supervisor:REFRAME_PLAN" in t for t in ss.switch_triggers)


def test_reframe_without_caller_state_falls_through(monkeypatch):
    d = SupervisorDirective(action="REFRAME_PLAN", rationale="x", plan_note="new framing")
    _r, ss, _tg, _wm = _run(d, caller_state=None, monkeypatch=monkeypatch)
    assert ss.current_strategy == "TRACE_EXEC"


# ── INV-22 — stall-edge only ───────────────────────────────────────────────


def test_inv22_directive_ignored_when_not_stalled(monkeypatch):
    monkeypatch.setenv("HARNESS_TRAJECTORY_SUPERVISOR", "1")
    ss = StrategyState(completion_history=[1, 2, 3])  # not stalled
    d = SupervisorDirective(action="REDIRECT_STRATEGY", rationale="x", strategy_hint="REIMPLEMENT")
    _r, out_ss, _tg, _wm = _run(d, stalled=False, strategy_state=ss)
    assert out_ss.current_strategy == "DIRECT_EDIT"
    assert out_ss.switch_count == 0
    assert not any("supervisor" in t for t in out_ss.switch_triggers)


# ── INV-21 — no resolver / belief / hypothesis mutation ────────────────────


def test_inv21_directive_does_not_change_resolver_or_world_model(monkeypatch):
    monkeypatch.setenv("HARNESS_TRAJECTORY_SUPERVISOR", "1")
    d = SupervisorDirective(action="REDIRECT_STRATEGY", rationale="x", strategy_hint="REIMPLEMENT")

    r_with, _ss1, _tg1, wm_with = _run(d, monkeypatch=monkeypatch)
    r_without, _ss2, _tg2, wm_without = _run(None)

    # The supervisor never influences the control-state resolver (INV-06 / INV-21).
    assert r_with["control_state_a"].to_dict() == r_without["control_state_a"].to_dict()
    assert r_with["control_state_b"].to_dict() == r_without["control_state_b"].to_dict()

    # ...nor adds / removes / edits beliefs, observations, or contradictions.
    def _shape(wm):
        return {
            "beliefs": sorted((b.id, b.statement, b.confidence) for b in wm.beliefs),
            "observations": sorted((o.id, o.content) for o in wm.observations),
            "contradictions": sorted((c.id, c.severity, c.description) for c in wm.contradictions),
        }

    assert _shape(wm_with) == _shape(wm_without)


# ── INV-20 — one-shot: no residual redirect on the next iteration ──────────


def test_inv20_directive_not_reapplied_next_iteration(monkeypatch):
    monkeypatch.setenv("HARNESS_TRAJECTORY_SUPERVISOR", "1")
    ss = StrategyState(completion_history=list(STALL_HISTORY))
    d = SupervisorDirective(action="REDIRECT_STRATEGY", rationale="x", strategy_hint="BROADER_SEARCH")

    _r, ss, _tg, _wm = _run(d, strategy_state=ss)
    assert ss.current_strategy == "BROADER_SEARCH"

    # Next iteration, still stalled, no directive passed → normal ladder advance
    # from BROADER_SEARCH, i.e. REIMPLEMENT — not a re-redirect back to BROADER_SEARCH.
    _r2, ss2, _tg2, _wm2 = _run(None, strategy_state=ss)
    assert ss2.current_strategy == STRATEGY_ORDER[STRATEGY_ORDER.index("BROADER_SEARCH") + 1]


# ── budget honesty ─────────────────────────────────────────────────────────


def test_supervisor_path_consumes_recovery_budget(monkeypatch):
    monkeypatch.setenv("HARNESS_TRAJECTORY_SUPERVISOR", "1")
    budget = RecoveryBudget(max_plan_revisions=3)
    d = SupervisorDirective(action="REDIRECT_STRATEGY", rationale="x", strategy_hint="REIMPLEMENT")
    r, _ss, _tg, _wm = _run(d, recovery_budget=budget, monkeypatch=monkeypatch)
    assert r["recovery_budget"].plan_revisions_used == 1


def test_repeated_supervisor_stalls_still_escalate_on_budget(monkeypatch):
    monkeypatch.setenv("HARNESS_TRAJECTORY_SUPERVISOR", "1")
    budget = RecoveryBudget(max_plan_revisions=3, plan_revisions_used=3)  # already exhausted
    ss = StrategyState(completion_history=list(STALL_HISTORY))
    d = SupervisorDirective(action="REDIRECT_STRATEGY", rationale="x", strategy_hint="REIMPLEMENT")
    result, _ss, _tg, _wm = _run(d, recovery_budget=budget, strategy_state=ss)
    assert result.get("escalated") is True


# ── decide() fail-safe matrix ──────────────────────────────────────────────

_mock_litellm = MagicMock()
_mock_litellm.acompletion = AsyncMock()


@pytest.fixture
def mock_litellm(monkeypatch):
    monkeypatch.setitem(sys.modules, "litellm", _mock_litellm)
    _mock_litellm.acompletion.reset_mock()
    _mock_litellm.acompletion.side_effect = None
    return _mock_litellm


def _resp(body: str):
    msg = MagicMock()
    msg.content = body
    choice = MagicMock()
    choice.message = msg
    r = MagicMock()
    r.choices = [choice]
    return r


def _digest():
    from harness.trajectory_digest import build_digest

    return build_digest(
        StrategyState(stall_reason="strategy_loop", switch_count=2, switch_triggers=["a", "b"]),
        FailureDiagnostics(failure_history=[FailureEntry(failure_class="compile_error", step=i) for i in range(3)]),
        TaskGraph(),
        WorldModel(),
    )


@pytest.mark.asyncio
async def test_decide_returns_redirect_on_clean_response(mock_litellm):
    mock_litellm.acompletion.return_value = _resp(
        '{"action": "REDIRECT_STRATEGY", "rationale": "tracing", "strategy_hint": "TRACE_EXEC"}'
    )
    d = await decide_supervisor_directive(_digest())
    assert d.action == "REDIRECT_STRATEGY"
    assert d.strategy_hint == "TRACE_EXEC"


@pytest.mark.asyncio
async def test_decide_fail_safe_on_llm_error(mock_litellm):
    mock_litellm.acompletion.side_effect = RuntimeError("backend down")
    d = await decide_supervisor_directive(_digest())
    assert d.action == "CONTINUE"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    ["", "not json", '{"foo": "bar"}', '{"action": 42}', '{"action": "REDIRECT_STRATEGY"}', "[1, 2, 3]"],
)
async def test_decide_fail_safe_on_bad_body(mock_litellm, body):
    mock_litellm.acompletion.return_value = _resp(body)
    d = await decide_supervisor_directive(_digest())
    assert d.action == "CONTINUE"


@pytest.mark.asyncio
async def test_decide_passes_through_a_valid_abort(mock_litellm):
    mock_litellm.acompletion.return_value = _resp('{"action": "ABORT", "rationale": "unrecoverable"}')
    d = await decide_supervisor_directive(_digest())
    assert d.action == "ABORT"  # loop.py escalates on it (S6) — decide() itself is faithful
