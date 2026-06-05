"""
Phase 9 acceptance tests — Reviewer Pass & Output Contract.

Tests T01–T12 as specified in plan/phase_9_plan.html.
All tests are infrastructure-free (no Postgres required).

Run with: pytest adapter/tests/test_harness_p9.py -v
"""

from __future__ import annotations

import sys
import uuid
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.belief_graph import BeliefDepGraph, BeliefEdge, DepGraphBudget
from harness.caller_state import CallerState, inject_clarification
from harness.constraint_propagation import apply_constraint_change_propagation
from harness.evidence import Evidence, EvidenceStore, EvidenceType
from harness.failure_modes import FailureDiagnostics, FailureEntry
from harness.hypothesis import Hypothesis, HypothesisSet
from harness.output_contract import (
    ContractCheckResult,
    OutputContract,
    check_caller_specific_constraints,
    check_format_requirements,
    check_interface_constraints,
    check_required_sections,
    validate_output_contract,
)
from harness.reviewer import (
    AdversarialPrior,
    ReviewFinding,
    ReviewPassResult,
    adversarial_lens,
    compute_causal_proximity,
    drain_propagation_queue,
    implementer_lens,
    reviewer_lens,
    reviewer_pass,
    seed_adversarial_prior,
)
from harness.task_graph import Task, TaskGraph
from harness.world_model import Belief, Observation, WorldModel


# ─── Fixtures / helpers ───────────────────────────────────────────────────────


def _belief(statement: str, confidence: float = 0.8, bid: str | None = None) -> Belief:
    return Belief(
        id=bid or str(uuid.uuid4()),
        statement=statement,
        confidence=confidence,
        derived_from=["init"],
    )


def _observation(content: str, source: str = "tool", oid: str | None = None) -> Observation:
    return Observation(
        id=oid or str(uuid.uuid4()),
        content=content,
        source=source,
    )


def _task(
    tid: str,
    status: str = "PENDING",
    description: str = "do something",
    completed_evidence: list[str] | None = None,
    abstraction_level: int = 0,
) -> Task:
    return Task(
        id=tid,
        description=description,
        status=status,
        completed_evidence=completed_evidence or [],
        abstraction_level=abstraction_level,
    )


def _dep_graph(
    nodes: dict[str, str] | None = None,
    edges: list[tuple[str, str]] | None = None,
    propagation_queue: list[str] | None = None,
) -> BeliefDepGraph:
    g = BeliefDepGraph(
        belief_nodes=nodes or {},
        edges=[BeliefEdge(from_id=f, to_id=t, confidence=0.8) for f, t in (edges or [])],
        invalidation_frontier=set(),
        propagation_queue=list(propagation_queue or []),
        dep_graph_quality=1.0,
    )
    return g


def _evidence_store(*entries: Evidence) -> EvidenceStore:
    es = EvidenceStore()
    for e in entries:
        es.entries.append(e)
    return es


def _evidence(obs: str, reliability: str = "HIGH", ev_id: str | None = None) -> Evidence:
    return Evidence(
        id=ev_id or str(uuid.uuid4()),
        obs=obs,
        source="test",
        reliability=reliability,
        evidence_type=EvidenceType.OBSERVATION,
    )


# ─── T01 — seed_adversarial_prior selects by causal proximity, not confidence ─


def test_T01_seed_selects_by_causal_proximity():
    """Belief B (low confidence, direct causal path) beats belief A (high confidence, no path)."""
    wm = WorldModel()

    b_id = "belief_B"
    a_id = "belief_A"
    sc_id = "sc_root"

    belief_a = _belief("system state A is stable", confidence=0.95, bid=a_id)
    belief_b = _belief("task output validates success", confidence=0.40, bid=b_id)
    wm.beliefs.extend([belief_a, belief_b])

    dep_graph = _dep_graph(
        nodes={a_id: "belief A", b_id: "belief B", sc_id: "success criteria"},
        # Edge: B → sc_id (direct causal path from B to success criterion)
        edges=[(b_id, sc_id)],
    )

    success_criteria = [sc_id]  # sc_id is an exact belief node ID
    prior = seed_adversarial_prior(
        world_model=wm,
        success_criteria=success_criteria,
        failure_history=None,
        belief_dep_graph=dep_graph,
        top_k=5,
    )

    seeded_ids = {d["belief_id"] for d in prior.negated_beliefs}

    # B must be seeded; A must NOT be seeded (no causal path, so proximity=0.0)
    assert b_id in seeded_ids, "Belief B (direct causal path) must be in adversarial prior"
    assert a_id not in seeded_ids, "Belief A (no causal path) must NOT be selected"


# ─── T02 — INV-09: no AdversarialPrior reference persists after reviewer_pass ─


def test_T02_adversarial_prior_discarded_after_reviewer_pass():
    """No field of world_model or hypothesis_set holds an AdversarialPrior after reviewer_pass()."""
    wm = WorldModel()
    b = _belief("implementation is correct", bid="b1")
    wm.beliefs.append(b)
    wm.assumptions.append("tests cover all paths")

    tg = TaskGraph(tasks=[_task("T1", status="COMPLETE")])
    hs = HypothesisSet()
    dep_graph = _dep_graph(nodes={"b1": "b1"})
    oc = OutputContract()
    cs = CallerState(success_criteria=["done"])

    result = reviewer_pass(
        world_model=wm,
        task_graph=tg,
        success_criteria=["done"],
        output_contract=oc,
        hypothesis_set=hs,
        evidence_store=EvidenceStore(),
        caller_state=cs,
        belief_dep_graph=dep_graph,
        failure_history=None,
    )

    # Inspect all fields of world_model, hypothesis_set, result
    def _has_adversarial_prior(obj: Any, visited: set[int] | None = None) -> bool:
        if visited is None:
            visited = set()
        obj_id = id(obj)
        if obj_id in visited:
            return False
        visited.add(obj_id)
        if isinstance(obj, AdversarialPrior):
            return True
        if isinstance(obj, (str, int, float, bool, bytes, type(None))):
            return False
        if isinstance(obj, dict):
            return any(_has_adversarial_prior(v, visited) for v in obj.values())
        if isinstance(obj, (list, tuple, set, frozenset)):
            return any(_has_adversarial_prior(item, visited) for item in obj)
        if hasattr(obj, "__dict__"):
            return any(_has_adversarial_prior(v, visited) for v in vars(obj).values())
        return False

    assert not _has_adversarial_prior(wm), "world_model must not hold AdversarialPrior"
    assert not _has_adversarial_prior(hs), "hypothesis_set must not hold AdversarialPrior"
    assert not _has_adversarial_prior(result), "ReviewPassResult must not hold AdversarialPrior"
    assert isinstance(result, ReviewPassResult)


# ─── T03 — dep_class_gap_annotation beliefs appear in prior ───────────────────


def test_T03_dep_class_gap_annotation_included():
    """When dep_class_gap_annotation references belief C, it appears in prior and flag is True."""
    wm = WorldModel()
    c_id = "belief_C"
    wm.beliefs.append(_belief("class gap belief", bid=c_id))

    dep_graph = _dep_graph(nodes={c_id: "belief C"})
    gap_annotation = {"belief_ids": [c_id]}

    prior = seed_adversarial_prior(
        world_model=wm,
        success_criteria=[],
        failure_history=None,
        dep_class_gap_annotation=gap_annotation,
        belief_dep_graph=dep_graph,
    )

    seeded_ids = {d["belief_id"] for d in prior.negated_beliefs}
    assert c_id in seeded_ids, "Belief C referenced by dep_class_gap_annotation must be seeded"
    assert prior.dep_class_gap_included is True


# ─── T04 — All three lenses produce findings for non-trivial world_model ──────


def test_T04_all_three_lenses_produce_findings():
    """reviewer_pass() returns findings from all three lenses for a non-trivial setup."""
    wm = WorldModel()

    b_id = "b_sc"
    sc_id = "sc1"
    belief_b = _belief("task output validates success", confidence=0.5, bid=b_id)
    wm.beliefs.append(belief_b)
    wm.assumptions.append("all dependencies installed")  # unvalidated

    # COMPLETE task with NO supporting observation → implementer finding
    t1 = _task("T1", status="COMPLETE", description="implement feature",
               completed_evidence=[b_id])
    tg = TaskGraph(tasks=[t1])

    dep_graph = _dep_graph(
        nodes={b_id: "belief B", sc_id: "success criteria"},
        edges=[(b_id, sc_id)],
    )

    hs = HypothesisSet()
    # Hypothesis whose discriminating_evidence is ONLY b_id (adversarial lens will flag it)
    hyp = Hypothesis(
        id="h1",
        explanation="feature was implemented correctly",
        confidence=0.6,
        predicted_observations=[],
        discriminating_evidence=[b_id],
        generation_sources=["symptom_inference"],
    )
    hs.active.append(hyp)

    oc = OutputContract(required_sections=["summary"])  # required_sections but result has none
    es = EvidenceStore()
    cs = CallerState(success_criteria=[sc_id])

    result = reviewer_pass(
        world_model=wm,
        task_graph=tg,
        success_criteria=[sc_id],
        output_contract=oc,
        hypothesis_set=hs,
        evidence_store=es,
        caller_state=cs,
        belief_dep_graph=dep_graph,
        failure_history=None,
    )

    assert isinstance(result, ReviewPassResult)
    lenses_present = {f.lens for f in result.findings}

    assert "implementer" in lenses_present, "implementer_lens must produce at least one finding"
    assert "reviewer" in lenses_present, "reviewer_lens must produce at least one finding"
    assert "adversarial" in lenses_present, "adversarial_lens must produce at least one finding"


# ─── T05 — Adversarial lens finds a distinct failure mode ────────────────────


def test_T05_adversarial_lens_finds_distinct_finding():
    """Adversarial lens produces at least one finding absent from implementer + reviewer lenses."""
    wm = WorldModel()

    b_id = "b_proximal"
    sc_id = "sc_done"
    belief_b = _belief("output is validated", confidence=0.6, bid=b_id)
    wm.beliefs.append(belief_b)

    # COMPLETE task WITH a supporting observation (so implementer_lens won't flag it)
    obs = _observation(content="T1 executed successfully", source="T1")
    wm.observations.append(obs)
    t1 = _task("T1", status="COMPLETE", description="done",
               completed_evidence=[b_id])
    tg = TaskGraph(tasks=[t1])

    dep_graph = _dep_graph(
        nodes={b_id: "belief B", sc_id: "success criteria done"},
        edges=[(b_id, sc_id)],
    )

    hs = HypothesisSet()
    # Hypothesis only supported by b_id — adversarial lens should flag it
    hyp = Hypothesis(
        id="h_adv",
        explanation="all criteria met",
        confidence=0.7,
        predicted_observations=[],
        discriminating_evidence=[b_id],
        generation_sources=["symptom_inference"],
    )
    hs.active.append(hyp)

    oc = OutputContract()
    es = EvidenceStore()
    cs = CallerState(success_criteria=[sc_id])

    result = reviewer_pass(
        world_model=wm,
        task_graph=tg,
        success_criteria=[sc_id],
        output_contract=oc,
        hypothesis_set=hs,
        evidence_store=es,
        caller_state=cs,
        belief_dep_graph=dep_graph,
        failure_history=None,
    )

    impl_and_rev_descriptions = {
        f.description
        for f in result.findings
        if f.lens in ("implementer", "reviewer")
    }
    adv_findings = [f for f in result.findings if f.lens == "adversarial"]

    assert len(adv_findings) >= 1, "adversarial lens must produce at least one finding"
    # At least one adversarial finding must describe something not in impl+rev
    distinct = [f for f in adv_findings if f.description not in impl_and_rev_descriptions]
    assert distinct, "adversarial lens must find at least one issue distinct from impl/reviewer lenses"


# ─── T06 — abstraction_fit recomputed unconditionally ────────────────────────


def test_T06_abstraction_fit_recomputed_when_task_graph_not_changed():
    """abstraction_fit is recomputed by reviewer_pass even when task_graph.changed is False."""
    from harness.task_graph import check_abstraction_alignment

    wm = WorldModel()
    # High-granularity task: abstraction_level=2 but world model has no statement-level beliefs
    t1 = _task("T1", status="COMPLETE", description="edit line 42",
               abstraction_level=2)  # statement level
    tg = TaskGraph(tasks=[t1])
    tg.changed = False  # explicitly mark as not changed

    dep_graph = _dep_graph()
    oc = OutputContract()
    cs = CallerState(success_criteria=[])
    es = EvidenceStore()
    hs = HypothesisSet()

    # Pre-pass: compute abstraction fit via standard path (respects changed=False → returns 1.0)
    pre_score = check_abstraction_alignment(tg, wm, force=False)
    assert pre_score == 1.0, "pre-pass score with changed=False should be 1.0 (skipped)"

    result = reviewer_pass(
        world_model=wm,
        task_graph=tg,
        success_criteria=[],
        output_contract=oc,
        hypothesis_set=hs,
        evidence_store=es,
        caller_state=cs,
        belief_dep_graph=dep_graph,
        failure_history=None,
    )

    # reviewer_pass calls check_abstraction_alignment with force=True — score reflects real state
    assert result.abstraction_fit_score < 1.0, (
        "reviewer_pass must recompute abstraction_fit unconditionally "
        f"(got {result.abstraction_fit_score}, expected < 1.0)"
    )


# ─── T07 — drain_propagation_queue reopens COMPLETE task ─────────────────────


def test_T07_drain_reopens_complete_task():
    """HIGH ReviewFinding invalidates COMPLETE task evidence → task transitions to PENDING."""
    belief_id = "belief_to_invalidate"
    t1 = _task("T1", status="COMPLETE", completed_evidence=[belief_id])
    tg = TaskGraph(tasks=[t1])

    dep_graph = _dep_graph(
        nodes={belief_id: "key belief"},
        propagation_queue=[belief_id],
    )

    reopened = drain_propagation_queue(dep_graph, tg)

    assert "T1" in reopened, "T1 should be reopened because its evidence belief is invalidated"
    assert t1.status == "PENDING", "Task T1 status must be PENDING after drain"
    assert t1.completed_evidence == [], "completed_evidence must be cleared after reopen"
    assert dep_graph.propagation_queue == [], "propagation_queue must be cleared"


# ─── T08 — empty propagation_queue → no re-entry ─────────────────────────────


def test_T08_empty_propagation_queue_no_reentry():
    """Empty propagation_queue → drain returns [], tasks_reopened=False, loop does not re-enter."""
    t1 = _task("T1", status="COMPLETE", completed_evidence=["b1"])
    tg = TaskGraph(tasks=[t1])
    dep_graph = _dep_graph(propagation_queue=[])

    reopened = drain_propagation_queue(dep_graph, tg)

    assert reopened == [], "No tasks should be reopened when queue is empty"
    assert t1.status == "COMPLETE", "T1 status must remain COMPLETE"

    # Simulate what reviewer_pass does with the drain result
    rpr = ReviewPassResult(tasks_reopened=bool(reopened))
    assert rpr.tasks_reopened is False


# ─── T09 — FAILED task is not reopened by drain ──────────────────────────────


def test_T09_failed_task_not_reopened():
    """FAILED task is not transitioned to PENDING by drain_propagation_queue."""
    belief_id = "b_invalid"
    t_failed = _task("T_FAIL", status="FAILED", completed_evidence=[belief_id])
    t_complete = _task("T_OK", status="COMPLETE", completed_evidence=[belief_id])
    tg = TaskGraph(tasks=[t_failed, t_complete])

    dep_graph = _dep_graph(propagation_queue=[belief_id])

    reopened = drain_propagation_queue(dep_graph, tg)

    # Only COMPLETE tasks get reopened
    assert "T_FAIL" not in reopened, "FAILED task must not be reopened"
    assert t_failed.status == "FAILED", "FAILED task status must remain FAILED"
    assert "T_OK" in reopened, "COMPLETE task T_OK should be reopened"
    assert t_complete.status == "PENDING"


# ─── T10 — full validate catches missing field that shadow check missed ───────


def test_T10_full_validate_catches_missing_field():
    """Full validate_output_contract catches a field that contract_shadow_check would miss.

    The shadow check only inspects field presence in a dict result.
    Full validate additionally checks format_requirements and required_sections.
    We test a required_sections miss.
    """
    from harness.output_contract import contract_shadow_check

    oc = OutputContract(
        required_interface_fields=["status"],
        required_sections=["conclusion"],  # section only enforced by full validator
    )

    # Result has required field but missing section
    result = {"status": "ok"}

    shadow = contract_shadow_check(result, oc)
    assert shadow.passed, "Shadow check only checks fields — should pass"
    assert shadow.is_stub is False

    full = validate_output_contract(result, oc, caller_state=None)
    assert not full.passed, "Full validator must catch missing required_section 'conclusion'"
    assert any("conclusion" in v for v in full.violations)
    assert full.is_stub is False


# ─── T11 — validate uses updated caller_state constraints ────────────────────


def test_T11_validate_uses_updated_caller_state_constraints():
    """check_caller_specific_constraints uses the live current_constraints, not original."""
    oc = OutputContract()
    cs = CallerState(current_constraints=["output must not reference deleted files"])

    # Result that violates the constraint
    result = {"summary": "edited the deleted files in the repo"}

    check = validate_output_contract(result, oc, caller_state=cs)

    assert not check.passed, "Constraint 'must not reference deleted files' should be violated"
    assert any("deleted" in v.lower() or "constraint" in v.lower() for v in check.violations)
    assert check.is_stub is False


# ─── T12 — full validate returns passed=True when all sub-checks pass ─────────


def test_T12_full_validate_passes_when_all_checks_pass():
    """Full validate returns ContractCheckResult(passed=True, violations=[], is_stub=False)."""
    oc = OutputContract(
        required_interface_fields=["status", "summary"],
        interface_constraints={"status": "str", "summary": "str"},
        required_sections=["status", "summary"],
        format_requirements={},
        caller_specific_constraints=[],
    )
    cs = CallerState(current_constraints=[])

    result = {"status": "done", "summary": "all tasks complete"}

    check = validate_output_contract(result, oc, caller_state=cs)

    assert check.passed is True, f"Expected passed=True, got violations={check.violations}"
    assert check.violations == []
    assert check.is_stub is False


# ─── Additional: compute_causal_proximity unit tests ──────────────────────────


def test_compute_causal_proximity_direct_path():
    """Belief with direct edge to success criterion gets proximity > 0."""
    dep_graph = _dep_graph(
        nodes={"b1": "b1 description", "sc": "success criteria"},
        edges=[("b1", "sc")],
    )
    score = compute_causal_proximity("b1", ["sc"], dep_graph)
    assert score > 0.0
    # Distance 1 from "b1" to "sc" via undirected graph → 1/(1+1) = 0.5
    assert score == pytest.approx(0.5)


def test_compute_causal_proximity_no_path():
    """Belief with no path to success criterion scores 0.0."""
    dep_graph = _dep_graph(
        nodes={"b1": "b1 description", "sc": "success criteria"},
        edges=[],  # no edges
    )
    score = compute_causal_proximity("b1", ["sc"], dep_graph)
    assert score == 0.0


def test_drain_propagation_queue_clears_queue():
    """drain_propagation_queue always clears propagation_queue even when no tasks match."""
    dep_graph = _dep_graph(propagation_queue=["orphan_belief"])
    tg = TaskGraph(tasks=[])

    drain_propagation_queue(dep_graph, tg)
    assert dep_graph.propagation_queue == []
