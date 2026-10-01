"""
Phase 9 acceptance tests — Reviewer Pass & Output Contract.

Twin of packages/harness/src/nodes/reviewer-pass.ts and nodes/output-validation.ts. All tests are
infrastructure-free (no Postgres required).

Run with: pytest adapter/tests/test_harness_p9.py -v
"""

from __future__ import annotations

import sys
import uuid
from pathlib import Path
from typing import cast

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.belief_graph import BeliefDepGraph, BeliefEdge, DepGraphBudget
from harness.caller_state import CallerState
from harness.diagnostics import Diagnostics
from harness.evidence import EvidenceStore
from harness.failure_modes import FailureDiagnostics
from harness.hypothesis import HypothesisSet
from harness.output_contract import (
    OutputContract,
    OutputContractError,
    output_validation,
    validate_output_contract,
)
from harness.reviewer import (
    PropagationQueue,
    ReviewerVerdict,
    ReviewPassResult,
    drain_propagation_queue,
    reviewer_pass,
    seed_adversarial_prior,
)
from harness.task_graph import Task, TaskGraph, TaskStatus
from harness.world_model import Belief, Contradiction, WorldModel


@pytest.fixture(autouse=True)
def _lexical_checks_on(monkeypatch):
    """These tests exercise the harness's lexical checks, which are off by default (harness/lexical_off.py)."""
    monkeypatch.setenv("HARNESS_LEXICAL_MODE", "enabled")


# ─── Fixtures / helpers ───────────────────────────────────────────────────────


def _belief(
    statement: str, confidence: float = 0.8, bid: str | None = None, derived_from: list[str] | None = None
) -> Belief:
    return Belief(
        id=bid or str(uuid.uuid4()),
        statement=statement,
        confidence=confidence,
        derived_from=["init"] if derived_from is None else derived_from,
    )


def _task(tid: str, status: str = "PENDING", description: str = "do something") -> Task:
    return Task(id=tid, description=description, status=cast(TaskStatus, status))


def _graph(*edges: tuple[str, str]) -> BeliefDepGraph:
    return BeliefDepGraph(derived_from_edges=[BeliefEdge(from_id=f, to_id=t, confidence=0.8) for f, t in edges])


def _contradiction(severity: str, belief_ids: list[str], description: str = "d") -> Contradiction:
    return Contradiction(
        id=str(uuid.uuid4()),
        type="pairwise",
        severity=severity,  # type: ignore[arg-type]
        scope="local",
        involved_belief_ids=belief_ids,
        description=description,
    )


def _pass(wm, criteria=(), tg=None, graph=None, fd=None, **kw) -> ReviewPassResult:
    return reviewer_pass(
        wm,
        list(criteria),
        fd or FailureDiagnostics(),
        graph or BeliefDepGraph(),
        DepGraphBudget(),
        HypothesisSet(),
        tg or TaskGraph(),
        Diagnostics(),
        EvidenceStore(),
        kw.pop("queue", PropagationQueue()),
        **kw,
    )


# ─── seed_adversarial_prior ───────────────────────────────────────────────────


def test_T01_seed_starts_from_beliefs_near_the_goal_and_walks_the_graph():
    """A belief naming the criterion (proximity 1.0) and beliefs with a derived_from chain (0.6) seed the walk;
    a belief with neither (0.1) is only reached through an edge. Edges are followed in both directions."""
    wm = WorldModel()
    named = _belief("the export job finishes", bid="named", derived_from=[])
    derived = _belief("unrelated but sourced", bid="derived")
    orphan = _belief("nothing links here", bid="orphan", derived_from=[])
    far = _belief("far away", bid="far", derived_from=[])
    wm.beliefs.extend([orphan, far, derived, named])
    graph = _graph(("orphan", "named"))  # orphan reached from the named belief via the reverse direction

    seeds = seed_adversarial_prior(wm, ["the export job finishes"], graph)

    assert [b.id for b in seeds] == ["derived", "named", "orphan"]
    assert "far" not in [b.id for b in seeds]


def test_T02_seed_respects_hop_limit_and_seed_cap():
    """The walk stops after 3 hops and never returns more than max_seeds beliefs."""
    wm = WorldModel()
    chain = [_belief(f"b{i}", bid=f"b{i}", derived_from=[]) for i in range(6)]
    chain[0].statement = "goal text"
    wm.beliefs.extend(chain)
    graph = _graph(*[(f"b{i}", f"b{i + 1}") for i in range(5)])

    seeds = seed_adversarial_prior(wm, ["goal text"], graph)
    assert [b.id for b in seeds] == ["b0", "b1", "b2", "b3"]  # hops 0..3

    many = WorldModel()
    many.beliefs.extend(_belief(f"s{i}", bid=f"s{i}") for i in range(30))
    assert len(seed_adversarial_prior(many, [], BeliefDepGraph(), 10)) == 10


def test_T03_criterion_proximity_is_a_lexical_check(monkeypatch):
    """With criterion-proximity off the criterion text no longer gives proximity 1.0 (a belief without a
    derived_from chain then scores 0.1 and is not a seed)."""
    wm = WorldModel()
    wm.beliefs.append(_belief("goal text", bid="g", derived_from=[]))
    assert [b.id for b in seed_adversarial_prior(wm, ["goal text"], BeliefDepGraph())] == ["g"]
    monkeypatch.delenv("HARNESS_LEXICAL_MODE")
    assert seed_adversarial_prior(wm, ["goal text"], BeliefDepGraph()) == []


# ─── lenses ───────────────────────────────────────────────────────────────────


def test_T04_implementer_lens_flags_uncovered_criteria_unless_semantically_covered():
    wm = WorldModel()
    wm.beliefs.append(_belief("the report was generated"))

    result = _pass(wm, ["report was generated", "emails were sent"])
    assert result.implementer_findings == ['Success criterion not covered by any belief: "emails were sent"']

    covered = _pass(wm, ["emails were sent"], semantic_criterion_coverage=lambda c, beliefs: True)
    assert covered.implementer_findings == []

    skipped = _pass(wm, ["emails were sent"], is_checkable_criterion=lambda c: False)
    assert skipped.implementer_findings == []


def test_T05_reviewer_lens_reports_unresolved_contradictions_and_weak_beliefs():
    wm = WorldModel()
    wm.beliefs.extend([_belief("a", 0.1, "a"), _belief("b", 0.2, "b"), _belief("c", 0.9, "c")])
    wm.contradictions.extend([_contradiction("HIGH", ["c"], "c fights a"), _contradiction("LOW", ["a"], "minor")])

    result = _pass(wm)
    assert result.reviewer_findings[0] == "Unresolved HIGH contradiction: c fights a"
    assert "More than half of beliefs have LOW confidence (2/3)" in result.reviewer_findings
    assert len(result.reviewer_findings) == 2


def test_T06_adversarial_lens_challenges_contradicted_high_confidence_beliefs_and_class_priors():
    wm = WorldModel()
    wm.beliefs.append(_belief("solid claim", 0.9, "solid"))
    wm.contradictions.append(_contradiction("LOW", ["solid"]))
    fd = FailureDiagnostics()
    fd.failure_mode_library.class_priors = {"SCOPE_CREEP": 0.72, "OTHER": 0.4}

    result = _pass(wm, fd=fd)
    assert 'Adversarial challenge: HIGH-reliability belief "solid" is contradicted' in result.adversarial_findings
    assert 'High prior probability (0.72) for failure class "SCOPE_CREEP"' in result.adversarial_findings
    assert len(result.adversarial_findings) == 2

    assert _pass(wm, fd=fd, run_adversarial_lens=False).adversarial_findings == []


# ─── pass side effects ────────────────────────────────────────────────────────


def test_T07_pass_recomputes_feasibility_from_an_unconditional_abstraction_check():
    """Even with task_graph.changed False the pass recomputes verification_health.feasibility (force=True)."""
    wm = WorldModel()
    wm.beliefs.append(_belief("The deployment module is healthy"))
    tg = TaskGraph(tasks=[Task(id="t", description="d", abstraction_level=2)], changed=False)
    diagnostics = Diagnostics()
    diagnostics.verification_health.feasibility = 0.9

    reviewer_pass(
        wm,
        [],
        FailureDiagnostics(),
        BeliefDepGraph(),
        DepGraphBudget(),
        HypothesisSet(),
        tg,
        diagnostics,
        EvidenceStore(),
        PropagationQueue(),
    )
    assert diagnostics.verification_health.feasibility == 0.0  # module-level beliefs vs a statement-level task


def test_T08_reopens_complete_tasks_named_by_a_reviewer_finding_without_changing_status():
    wm = WorldModel()
    wm.beliefs.append(_belief("x", 0.9, "b1"))
    wm.contradictions.append(_contradiction("HIGH", ["b1"], "output of task T_DONE is inconsistent"))
    tg = TaskGraph(tasks=[_task("T_DONE", "COMPLETE"), _task("T_PENDING", "PENDING"), _task("T_FAILED", "FAILED")])
    queue = PropagationQueue()

    result = _pass(wm, tg=tg, queue=queue)

    assert result.reopened_task_ids == ["T_DONE"]
    assert result.tasks_reopened is True
    assert tg.get_task("T_DONE").status == "COMPLETE"  # the caller reopens
    assert queue.reopened_task_ids == []  # drained


def test_T09_no_findings_no_reopen_no_verdict():
    result = _pass(WorldModel())
    assert result.reopened_task_ids == []
    assert result.tasks_reopened is False
    assert result.pending_verdict is None
    assert result.findings == []


def test_T09b_pass_detects_contradictions_on_the_world_model():
    wm = WorldModel()
    wm.beliefs.extend(
        [
            _belief("The module is present and available", 0.9, "p"),
            _belief("The module is absent and unavailable", 0.9, "a"),
        ]
    )
    _pass(wm)
    assert any(c.type == "pairwise" for c in wm.contradictions)


# ─── pending verdict ──────────────────────────────────────────────────────────


def test_pending_verdict_takes_the_highest_severity_finding_and_ties_go_to_the_first():
    wm = WorldModel()
    wm.beliefs.append(_belief("x", 0.9, "b1"))
    wm.contradictions.append(_contradiction("HIGH", ["b1"], "boom"))

    result = _pass(wm, ["never covered"])  # implementer MEDIUM, reviewer HIGH, adversarial HIGH
    assert result.pending_verdict == ReviewerVerdict("HIGH", "reviewer", "Unresolved HIGH contradiction: boom")

    only_medium = _pass(WorldModel(), ["never covered"])
    assert only_medium.pending_verdict == ReviewerVerdict(
        "MEDIUM", "implementer", 'Success criterion not covered by any belief: "never covered"'
    )
    assert ReviewerVerdict.from_dict(only_medium.pending_verdict.to_dict()) == only_medium.pending_verdict


def test_drain_propagation_queue_returns_and_clears():
    queue = PropagationQueue(["a", "b"])
    assert drain_propagation_queue(queue) == ["a", "b"]
    assert queue.reopened_task_ids == []
    assert drain_propagation_queue(queue) == []


def test_result_to_dict_shape():
    d = _pass(WorldModel(), ["c"]).to_dict()
    assert set(d) == {
        "implementer_findings",
        "reviewer_findings",
        "adversarial_findings",
        "reopened_task_ids",
        "pending_verdict",
    }


# ─── output validation (TS outputValidation) ─────────────────────────────────


def test_T10_validation_catches_missing_required_section():
    oc = OutputContract(required_sections=["conclusion"])
    with pytest.raises(OutputContractError) as exc:
        output_validation({"status": "ok"}, oc, None)
    assert exc.value.violated_dimension == "required_sections"
    assert exc.value.violations == ['required_sections: missing field "conclusion"']

    check = validate_output_contract({"status": "ok"}, oc, None)
    assert not check.passed and check.is_stub is False
    assert any("conclusion" in v for v in check.violations)


def test_T10b_validation_checks_json_format_rules_and_constraints():
    oc = OutputContract(format="json", validation_rules=["total: must be positive"], interface_constraints={"ok": True})
    with pytest.raises(OutputContractError) as exc:
        output_validation("not json", oc, None)
    assert exc.value.violations == [
        "format: expected JSON, got non-parseable string",
        'validation_rules: rule "total: must be positive" references missing field "total"',
    ]
    assert output_validation('{"a": 1}', OutputContract(format="json"), None).passed is True
    assert output_validation("anything", OutputContract(format="any"), None).passed is True

    with pytest.raises(OutputContractError) as exc:
        output_validation({"ok": False}, oc, None)
    assert exc.value.violations == [
        'interface_constraints: field "ok" expected true, got false',
        'validation_rules: rule "total: must be positive" references missing field "total"',
    ]


def test_T11_validation_uses_live_caller_constraints():
    oc = OutputContract()
    cs = CallerState(current_constraints=["output must not reference deleted files"])
    result = {"summary": "edited the deleted files in the repo"}

    check = validate_output_contract(result, oc, caller_state=cs)
    assert not check.passed
    assert check.violations == [
        'caller_specific_constraints: constraint violated: "output must not reference deleted files"'
    ]

    # the host's semantic judge replaces the lexical match
    assert validate_output_contract(result, oc, caller_state=cs, skip_caller_constraints=True).passed is True


def test_T11b_constraint_negation_is_a_lexical_check(monkeypatch):
    monkeypatch.delenv("HARNESS_LEXICAL_MODE")
    cs = CallerState(current_constraints=["output must not reference deleted files"])
    assert validate_output_contract({"s": "the deleted files"}, OutputContract(), caller_state=cs).passed is True


def test_T12_validation_passes_when_everything_holds():
    oc = OutputContract(required_sections=["status", "summary"], interface_constraints={"status": "done"})
    cs = CallerState(current_constraints=[])
    check = validate_output_contract({"status": "done", "summary": "all tasks complete"}, oc, caller_state=cs)
    assert check.passed is True
    assert check.violations == []
    assert check.is_stub is False
