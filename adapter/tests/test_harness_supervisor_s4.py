"""
S4 of plans/harness_trajectory_supervisor_plan.html — GATHER_EVIDENCE: the bounded
read-only investigation sub-agent.

Two layers:
  * harness/investigation.py — run_investigation() (INV-23/24/25), merge_investigation_findings()
    (provenance + generation bump), count_investigations() (per-run cap K).
  * loop.py stall branch — a GATHER_EVIDENCE directive pauses the iteration and returns
    {"investigation_requested": …}; per-run cap K and max-concurrent=1 degrade to the ladder.

Run: pytest adapter/tests/test_harness_supervisor_s4.py -q --noconftest
"""

from __future__ import annotations

import sys
import time
import uuid
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.diagnostics import (
    BeliefHealth,
    CoverageHealth,
    Diagnostics,
    ExecutionHealth,
    VerificationHealth,
)
from harness.evidence import EvidenceStore
from harness.failure_modes import FailureDiagnostics
from harness.hypothesis import HypothesisSet
from harness.investigation import (
    INVESTIGATION_READ_ONLY_TOOLS,
    InvestigationDepthExceeded,
    count_investigations,
    merge_investigation_findings,
    run_investigation,
    validate_investigation_tools,
)
from harness.loop import run_one_iteration
from harness.memory import MemoryState
from harness.recovery import RecoveryBudget, StrategyState
from harness.state_store import HarnessRunState
from harness.supervisor import InvestigationRequest, SupervisorDirective
from harness.task_graph import Task, TaskGraph
from harness.world_model import Belief, Observation, WorldModel

STALL_HISTORY = [0, 0, 0, 0, 0, 0]


def _diagnostics() -> Diagnostics:
    return Diagnostics(
        belief_health=BeliefHealth(freshness=0.9, consistency=0.9, support=0.9),
        coverage_health=CoverageHealth(symptom_coverage=0.9, explanation_coverage=0.9),
        verification_health=VerificationHealth(strength=0.9, feasibility=0.9),
        execution_health=ExecutionHealth(progress_rate=0.9, failure_recurrence=0.1, oscillation_score=0.1),
    )


def _world_model() -> WorldModel:
    wm = WorldModel()
    wm.add_observation(Observation(id="o0", content="obs", source="test"))
    wm.add_belief(Belief(id="b0", statement="belief 0", confidence=0.8, derived_from=["o0"]))
    return wm


def _run_stall(
    directive, *, wm=None, harness_run_state=None, recovery_budget=None, strategy_state=None, monkeypatch=None
):
    if monkeypatch is not None:
        monkeypatch.setenv("HARNESS_TRAJECTORY_SUPERVISOR", "1")
    wm = wm or _world_model()
    ss = strategy_state or StrategyState(completion_history=list(STALL_HISTORY))
    tg = TaskGraph(tasks=[Task(id="t1", description="primary", status="ACTIVE", abstraction_level=0)])
    result = run_one_iteration(
        world_model=wm,
        diagnostics=_diagnostics(),
        hypothesis_set=HypothesisSet(active=[], eliminated=[]),
        task_graph=tg,
        failure_diagnostics=FailureDiagnostics(),
        memory_state=MemoryState(),
        strategy_state=ss,
        recovery_budget=recovery_budget,
        harness_run_state=harness_run_state,
        step_count=0,
        supervisor_directive=directive,
    )
    # run_one_iteration replaces (not mutates) strategy_state on the ladder path; the
    # GATHER early-return has no strategy_state key, so this falls back to the original
    # object (whose switch_triggers list was mutated in place).
    return result, result.get("strategy_state", ss), wm


def _gather(question="which port is the adapter on?", tools=("retrieve",), budget=3):
    return SupervisorDirective(
        action="GATHER_EVIDENCE",
        rationale="stuck for a fact",
        investigation=InvestigationRequest(question=question, suggested_tools=list(tools), budget=budget),
    )


def _run_state() -> HarnessRunState:
    return HarnessRunState(
        run_id=str(uuid.uuid4()),
        world_model=_world_model(),
        diagnostics=_diagnostics(),
        task_graph=TaskGraph(tasks=[Task(id="t1", description="task", status="ACTIVE", abstraction_level=0)]),
        hypothesis_set=HypothesisSet(active=[], eliminated=[]),
        evidence_store=EvidenceStore(),
        strategy_state=StrategyState(),
        memory_state=MemoryState(),
        failure_diagnostics=FailureDiagnostics(),
    )


# ── run_investigation — INV-23 read-only allowlist ──────────────────────────


def test_validate_tools_rejects_write_shell_email_and_unknown():
    forbidden = ["write_file", "run_shell_command", "send_email", "deploy", "made_up_tool"]
    allowed, rejected = validate_investigation_tools([*forbidden, "retrieve", "web_search"])
    assert allowed == ["retrieve", "web_search"]
    assert set(rejected) == set(forbidden)
    assert "write_file" not in INVESTIGATION_READ_ONLY_TOOLS


def test_run_investigation_never_dispatches_a_rejected_tool():
    dispatched: list[str] = []

    def runner(tool, _q):
        dispatched.append(tool)
        return f"{tool}: found it"

    req = InvestigationRequest(
        question="q", suggested_tools=["write_file", "retrieve", "run_shell_command", "read_file"], budget=9
    )
    outcome = run_investigation(req, tool_runner=runner)
    assert dispatched == ["retrieve", "read_file"]
    assert set(outcome.rejected_tools) == {"write_file", "run_shell_command"}
    assert len(outcome.findings) == 2


# ── INV-24 depth cap ───────────────────────────────────────────────────────


def test_depth_cap_raises_at_depth_1():
    req = InvestigationRequest(question="q", suggested_tools=["retrieve"], budget=1)
    with pytest.raises(InvestigationDepthExceeded):
        run_investigation(req, tool_runner=lambda _t, _q: "x", depth=1)


def test_nested_gather_evidence_directive_coerced_away_by_from_dict_when_no_payload():
    # A GATHER_EVIDENCE surfaced from inside an investigation context would carry no
    # investigation payload (the sub-loop has no supervisor); from_dict coerces it to CONTINUE.
    d = SupervisorDirective.from_dict({"action": "GATHER_EVIDENCE", "rationale": "recurse"})
    assert d.action == "CONTINUE"


# ── INV-25 own bounded budget ──────────────────────────────────────────────


def test_budget_smaller_than_tool_list_returns_partial_and_exhausted():
    req = InvestigationRequest(question="q", suggested_tools=["retrieve", "web_search", "read_file"], budget=1)
    outcome = run_investigation(req, tool_runner=lambda t, _q: f"{t} ok")
    assert outcome.calls_made == 1
    assert outcome.exhausted is True
    assert [f.tool for f in outcome.findings] == ["retrieve"]


def test_hanging_tool_is_cut_off_by_timeout():
    def runner(tool, _q):
        if tool == "web_search":
            time.sleep(30)
        return f"{tool} ok"

    req = InvestigationRequest(question="q", suggested_tools=["web_search", "retrieve"], budget=5)
    started = time.monotonic()
    outcome = run_investigation(req, tool_runner=runner, per_call_timeout=0.2)
    assert time.monotonic() - started < 10
    assert [f.tool for f in outcome.findings] == ["retrieve"]
    assert outcome.calls_made == 2


def test_tool_that_raises_is_isolated():
    def runner(tool, _q):
        if tool == "retrieve":
            raise RuntimeError("boom")
        return f"{tool} ok"

    req = InvestigationRequest(question="q", suggested_tools=["retrieve", "read_file"], budget=5)
    outcome = run_investigation(req, tool_runner=runner)
    assert [f.tool for f in outcome.findings] == ["read_file"]


# ── merge — provenance + generation bump + empty ───────────────────────────


def test_merge_tags_provenance_and_bumps_generation():
    wm = _world_model()
    gen_before = wm.generation_id
    req = InvestigationRequest(question="which port?", suggested_tools=["retrieve"], budget=2)
    outcome = run_investigation(req, tool_runner=lambda _t, _q: "the adapter is on :8000")
    merged = merge_investigation_findings(wm, outcome, question=req.question)
    assert len(merged) == 1
    obs = merged[0]
    assert obs.source == "supervisor_investigation"
    assert "derived_from=supervisor_investigation" in obs.content
    assert "reliability=MEDIUM" in obs.content
    assert wm.generation_id > gen_before
    assert obs in wm.observations


def test_merge_high_reliability_when_tool_is_high():
    wm = _world_model()
    req = InvestigationRequest(question="q", suggested_tools=["retrieve"], budget=1)
    outcome = run_investigation(req, tool_runner=lambda _t, _q: "fact", tool_reliability={"retrieve": "HIGH"})
    merged = merge_investigation_findings(wm, outcome, question=req.question)
    assert "reliability=HIGH" in merged[0].content


def test_empty_investigation_merges_nothing_but_still_bumps_generation():
    wm = _world_model()
    gen_before = wm.generation_id
    req = InvestigationRequest(question="q", suggested_tools=["retrieve"], budget=1)
    outcome = run_investigation(req, tool_runner=lambda _t, _q: None)
    assert outcome.is_empty
    merged = merge_investigation_findings(wm, outcome, question=req.question)
    assert merged == []
    assert wm.generation_id > gen_before


def test_count_investigations_counts_distinct_investigations():
    wm = _world_model()
    for q in ("q1", "q1", "q2"):
        outcome = run_investigation(
            InvestigationRequest(question=q, suggested_tools=["retrieve"], budget=1),
            tool_runner=lambda _t, _q: "f",
        )
        merge_investigation_findings(wm, outcome, question=q)
    assert count_investigations(wm) == 2


# ── loop.py wiring ─────────────────────────────────────────────────────────


def test_flag_off_gather_evidence_is_inert(monkeypatch):
    monkeypatch.delenv("HARNESS_TRAJECTORY_SUPERVISOR", raising=False)
    result, ss, _wm = _run_stall(_gather())
    assert "investigation_requested" not in result
    assert ss.current_strategy == "TRACE_EXEC"  # plain ladder


def test_gather_evidence_returns_investigation_requested(monkeypatch):
    result, ss, _wm = _run_stall(_gather(), monkeypatch=monkeypatch)
    assert result["investigation_requested"]["question"] == "which port is the adapter on?"
    assert result["investigation_requested"]["suggested_tools"] == ["retrieve"]
    # ladder not advanced this iteration — the run paused
    assert ss.switch_count == 0
    assert any("supervisor:GATHER_EVIDENCE" in t for t in ss.switch_triggers)


def test_gather_evidence_consumes_recovery_budget(monkeypatch):
    budget = RecoveryBudget(max_plan_revisions=3)
    result, _ss, _wm = _run_stall(_gather(), recovery_budget=budget, monkeypatch=monkeypatch)
    assert result["recovery_budget"].plan_revisions_used == 1


def test_gather_evidence_persists_pending_on_state_carrying_driver(monkeypatch):
    hrs = _run_state()
    _run_stall(_gather(), harness_run_state=hrs, monkeypatch=monkeypatch)
    assert hrs.pending_investigation is not None
    assert hrs.pending_investigation.question == "which port is the adapter on?"


def test_second_gather_evidence_while_pending_falls_through(monkeypatch):
    hrs = _run_state()
    hrs.pending_investigation = InvestigationRequest(question="already running", suggested_tools=["retrieve"])
    result, ss, _wm = _run_stall(_gather(), harness_run_state=hrs, monkeypatch=monkeypatch)
    assert "investigation_requested" not in result  # max-concurrent = 1
    assert any("GATHER_EVIDENCE->CONTINUE" in t for t in ss.switch_triggers)


def test_per_run_cap_k_degrades_to_ladder(monkeypatch):
    wm = _world_model()
    # Seed 3 already-merged investigations → cap K hit.
    for i in range(3):
        outcome = run_investigation(
            InvestigationRequest(question=f"seed-{i}", suggested_tools=["retrieve"], budget=1),
            tool_runner=lambda _t, _q: "f",
        )
        merge_investigation_findings(wm, outcome, question=f"seed-{i}")
    assert count_investigations(wm) == 3
    result, ss, _wm = _run_stall(_gather(), wm=wm, monkeypatch=monkeypatch)
    assert "investigation_requested" not in result
    assert any("GATHER_EVIDENCE->CONTINUE" in t for t in ss.switch_triggers)


def test_gather_evidence_without_payload_coerced_by_from_dict():
    d = SupervisorDirective.from_dict({"action": "GATHER_EVIDENCE", "rationale": "x"})
    assert d.action == "CONTINUE"
