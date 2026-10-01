"""
Reviewer pass — Phase 9.

Twin of packages/harness/src/nodes/reviewer-pass.ts. Three lenses look at the finished work and return plain-text
findings:

  implementer   every success criterion should be covered by some belief (substring match — HARNESS_LEXICAL
                criterion-substring — or the host's `semantic_criterion_coverage`);
  reviewer      unresolved HIGH / SYSTEM_BREAKING contradictions, and "more than half the beliefs are LOW (<0.25)";
  adversarial   a HIGH-confidence belief (>= 0.8) near the goal that a contradiction involves, and any failure class
                whose prior probability exceeds 0.5.

The pass then propagates beliefs, regenerates hypotheses and re-detects contradictions, recomputes abstraction fit,
reopens COMPLETE tasks a reviewer finding names, and derives a one-shot pending verdict (INV-18): the highest
severity >= MEDIUM finding becomes a ReviewerVerdict that forces the next resolve_control_state() call into a
non-NORMAL execution mode. The AdversarialPrior seeds are ephemeral (INV-09) — a local list, never stored.
"""

from __future__ import annotations

from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from .lexical_off import harness_lexical_active

ReviewerVerdictSeverity = Literal["LOW", "MEDIUM", "HIGH"]
ReviewerVerdictLens = Literal["implementer", "reviewer", "adversarial"]

ADVERSARIAL_PROXIMITY_THRESHOLD = 0.5
ADVERSARIAL_MAX_SEEDS = 10
BFS_HOP_LIMIT = 3
WEAK_BELIEF_CONFIDENCE = 0.25
ADVERSARIAL_HIGH_CONFIDENCE = 0.8
CLASS_PRIOR_FINDING_THRESHOLD = 0.5

_SEVERITY_RANK: dict[str, int] = {"LOW": 0, "MEDIUM": 1, "HIGH": 2}

# (criterion, beliefs) -> covered?  Host-supplied semantic check (TS SemanticCriterionCoverage; sync here — the
# outer async driver awaits its model call before/around the pass).
SemanticCriterionCoverage = Callable[[str, list[Any]], bool]
CriterionCheckable = Callable[[str], bool]


@dataclass
class ReviewerVerdict:
    """Bounded, single-slot verdict that survives into the next iteration's HarnessRunState (Phase I / INV-18).

    resolve_control_state() reads this as an input (never writes it); only reviewer_pass() produces one.
    """

    severity: ReviewerVerdictSeverity
    lens: ReviewerVerdictLens
    summary: str

    def to_dict(self) -> dict[str, Any]:
        return {"severity": self.severity, "lens": self.lens, "summary": self.summary}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> ReviewerVerdict:
        return cls(severity=d["severity"], lens=d["lens"], summary=d["summary"])


@dataclass
class PropagationQueue:
    reopened_task_ids: list[str] = field(default_factory=list)


def drain_propagation_queue(queue: PropagationQueue) -> list[str]:
    """Take (and clear) the task ids queued for reopening."""
    ids = list(queue.reopened_task_ids)
    queue.reopened_task_ids = []
    return ids


@dataclass
class ReviewPassResult:
    implementer_findings: list[str] = field(default_factory=list)
    reviewer_findings: list[str] = field(default_factory=list)
    adversarial_findings: list[str] = field(default_factory=list)
    reopened_task_ids: list[str] = field(default_factory=list)
    pending_verdict: ReviewerVerdict | None = None

    @property
    def findings(self) -> list[str]:
        return [*self.implementer_findings, *self.reviewer_findings, *self.adversarial_findings]

    @property
    def tasks_reopened(self) -> bool:
        return bool(self.reopened_task_ids)

    def to_dict(self) -> dict[str, Any]:
        return {
            "implementer_findings": list(self.implementer_findings),
            "reviewer_findings": list(self.reviewer_findings),
            "adversarial_findings": list(self.adversarial_findings),
            "reopened_task_ids": list(self.reopened_task_ids),
            "pending_verdict": self.pending_verdict.to_dict() if self.pending_verdict is not None else None,
        }


def _classify_finding_severity(lens: str, finding: str) -> ReviewerVerdictSeverity:
    if lens == "reviewer" and (
        finding.startswith("Unresolved HIGH") or finding.startswith("Unresolved SYSTEM_BREAKING")
    ):
        return "HIGH"
    if lens == "adversarial" and finding.startswith("Adversarial challenge:"):
        return "HIGH"
    return "MEDIUM"


def _derive_pending_verdict(
    implementer_findings: list[str],
    reviewer_findings: list[str],
    adversarial_findings: list[str],
) -> ReviewerVerdict | None:
    """The highest-severity finding (>= MEDIUM) becomes the pending verdict; ties keep the first found, in lens
    order implementer, reviewer, adversarial. None when there are no findings."""
    candidates = [
        ReviewerVerdict(_classify_finding_severity(lens, f), lens, f)  # type: ignore[arg-type]
        for lens, findings in (
            ("implementer", implementer_findings),
            ("reviewer", reviewer_findings),
            ("adversarial", adversarial_findings),
        )
        for f in findings
    ]
    candidates = [c for c in candidates if _SEVERITY_RANK[c.severity] >= _SEVERITY_RANK["MEDIUM"]]
    if not candidates:
        return None
    top = candidates[0]
    for c in candidates[1:]:
        if _SEVERITY_RANK[c.severity] > _SEVERITY_RANK[top.severity]:
            top = c
    return top


# ── P9.1 — adversarial prior seeding ─────────────────────────────────────────


def seed_adversarial_prior(
    world_model: Any,
    success_criteria: list[str],
    belief_dep_graph: Any,
    max_seeds: int = ADVERSARIAL_MAX_SEEDS,
) -> list[Any]:
    """Beliefs near the goal to attack (TS seedAdversarialPrior). Ephemeral (INV-09): keep it a local.

    Every belief with causal proximity >= 0.5 (a criterion appears in its text -> 1.0, else it has a derived_from
    chain -> 0.6, else 0.1) starts a breadth-first walk over `derived_from_edges` (either direction), up to 3 hops,
    collecting at most `max_seeds` beliefs. The criterion-text test is HARNESS_LEXICAL criterion-proximity.
    """
    criteria = {c.lower() for c in success_criteria}

    def causal_proximity(belief: Any) -> float:
        text = belief.statement.lower()
        if harness_lexical_active("criterion-proximity") and any(c in text for c in criteria):
            return 1.0
        if belief.derived_from:
            return 0.6
        return 0.1

    beliefs_by_id = {b.id: b for b in world_model.beliefs}
    visited: set[str] = set()
    queue: deque[tuple[str, int]] = deque()
    selected: list[Any] = []

    for belief in world_model.beliefs:
        if causal_proximity(belief) >= ADVERSARIAL_PROXIMITY_THRESHOLD:
            queue.append((belief.id, 0))
            visited.add(belief.id)

    while queue and len(selected) < max_seeds:
        belief_id, hop = queue.popleft()
        belief = beliefs_by_id.get(belief_id)
        if belief is None:
            continue
        selected.append(belief)
        if hop >= BFS_HOP_LIMIT:
            continue
        for edge in belief_dep_graph.derived_from_edges:
            next_id = edge.to_id if edge.from_id == belief_id else edge.from_id if edge.to_id == belief_id else None
            if next_id and next_id not in visited:
                visited.add(next_id)
                queue.append((next_id, hop + 1))

    return selected


# ── lenses ────────────────────────────────────────────────────────────────────


def implementer_lens(
    world_model: Any,
    success_criteria: list[str],
    semantic_criterion_coverage: SemanticCriterionCoverage | None = None,
    is_checkable_criterion: CriterionCheckable | None = None,
) -> list[str]:
    findings: list[str] = []
    for criterion in success_criteria:
        if is_checkable_criterion is not None and not is_checkable_criterion(criterion):
            continue
        covered = harness_lexical_active("criterion-substring") and any(
            criterion.lower() in b.statement.lower() for b in world_model.beliefs
        )
        if not covered:
            semantically = (
                semantic_criterion_coverage(criterion, world_model.beliefs)
                if semantic_criterion_coverage is not None
                else False
            )
            if not semantically:
                findings.append(f'Success criterion not covered by any belief: "{criterion}"')
    return findings


def reviewer_lens(world_model: Any) -> list[str]:
    findings: list[str] = []
    for contradiction in world_model.contradictions:
        if contradiction.severity in ("HIGH", "SYSTEM_BREAKING"):
            findings.append(f"Unresolved {contradiction.severity} contradiction: {contradiction.description}")

    weak = [b for b in world_model.beliefs if b.confidence < WEAK_BELIEF_CONFIDENCE]
    if len(weak) > len(world_model.beliefs) / 2:
        findings.append(f"More than half of beliefs have LOW confidence ({len(weak)}/{len(world_model.beliefs)})")
    return findings


def adversarial_lens(
    world_model: Any,
    success_criteria: list[str],
    failure_diagnostics: Any,
    belief_dep_graph: Any,
) -> list[str]:
    findings: list[str] = []
    for belief in seed_adversarial_prior(world_model, success_criteria, belief_dep_graph, ADVERSARIAL_MAX_SEEDS):
        if belief.confidence >= ADVERSARIAL_HIGH_CONFIDENCE and any(
            belief.id in c.involved_belief_ids for c in world_model.contradictions
        ):
            findings.append(f'Adversarial challenge: HIGH-reliability belief "{belief.id}" is contradicted')

    for cls, prior in failure_diagnostics.failure_mode_library.class_priors.items():
        if prior > CLASS_PRIOR_FINDING_THRESHOLD:
            findings.append(f'High prior probability ({prior:.2f}) for failure class "{cls}"')
    return findings


def reviewer_pass(
    world_model: Any,
    success_criteria: list[str],
    failure_diagnostics: Any,
    belief_dep_graph: Any,
    dep_graph_budget: Any,
    hypothesis_set: Any,
    task_graph: Any,
    diagnostics: Any,
    evidence_store: Any,
    propagation_queue: PropagationQueue,
    run_adversarial_lens: bool = True,
    semantic_criterion_coverage: SemanticCriterionCoverage | None = None,
    is_checkable_criterion: CriterionCheckable | None = None,
) -> ReviewPassResult:
    """Run the three-lens reviewer pass (TS reviewerPass).

    Order: implementer, reviewer and (unless `run_adversarial_lens` is False) adversarial lenses; recompute
    verification_health.feasibility from an unconditional abstraction-fit check; propagate beliefs; regenerate
    hypotheses; detect contradictions. A reviewer finding that contains the id of a COMPLETE task queues that task
    for reopening. The pass returns the drained ids and does NOT change task statuses — the caller reopens them
    (TS sets them PENDING and runs the main loop again).
    """
    from .belief_graph import propagate_beliefs
    from .contradiction import detect_contradictions
    from .hypothesis import generate_update_hypotheses
    from .memory import MemoryState
    from .task_graph import check_abstraction_alignment

    impl_findings = implementer_lens(world_model, success_criteria, semantic_criterion_coverage, is_checkable_criterion)
    reviewer_findings = reviewer_lens(world_model)
    adversarial_findings = (
        adversarial_lens(world_model, success_criteria, failure_diagnostics, belief_dep_graph)
        if run_adversarial_lens
        else []
    )

    diagnostics.verification_health.feasibility = check_abstraction_alignment(task_graph, world_model, True)

    propagate_beliefs(belief_dep_graph, dep_graph_budget, world_model)
    generate_update_hypotheses(world_model, evidence_store, hypothesis_set, failure_diagnostics, MemoryState())
    detect_contradictions(world_model, evidence_store, hypothesis_set)

    reopened: list[str] = []
    for finding in reviewer_findings:
        for task in task_graph.tasks:
            if task.id in finding and task.status == "COMPLETE" and task.id not in reopened:
                reopened.append(task.id)
                propagation_queue.reopened_task_ids.append(task.id)

    return ReviewPassResult(
        implementer_findings=impl_findings,
        reviewer_findings=reviewer_findings,
        adversarial_findings=adversarial_findings,
        reopened_task_ids=drain_propagation_queue(propagation_queue),
        pending_verdict=_derive_pending_verdict(impl_findings, reviewer_findings, adversarial_findings),
    )
