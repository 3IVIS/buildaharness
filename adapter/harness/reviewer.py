"""
Reviewer pass — Phase 9.

Three-lens reviewer pass (implementer / reviewer / adversarial), adversarial
prior seeding via causal-proximity filter, and propagation drain that reopens
COMPLETE tasks whose underlying beliefs were invalidated.

Key invariants:
  INV-09: AdversarialPrior is ephemeral — it has no to_dict()/from_dict() and
          must never be stored outside the local scope of reviewer_pass().
  INV-01: ReviewFindings are integrated via add_observation() first; any
          corrective belief requires an explicit derived_from chain.
  INV-06: loop re-entry triggered by tasks_reopened does not write to
          control_state — only resolve_control_state() may produce a new value.
"""

from __future__ import annotations

import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Literal

ReviewFindingLens = Literal["implementer", "reviewer", "adversarial"]
ReviewFindingType = Literal[
    "contradiction",
    "gap",
    "regression",
    "assumption_violation",
    "contract_miss",
]
ReviewFindingSeverity = Literal["LOW", "MEDIUM", "HIGH"]

_HIGH_SEVERITY_DELTA = 0.1


# ── Data classes ─────────────────────────────────────────────────────────────


@dataclass
class ReviewFinding:
    lens: ReviewFindingLens
    finding_type: ReviewFindingType
    description: str
    affected_belief_ids: list[str] = field(default_factory=list)
    affected_task_ids: list[str] = field(default_factory=list)
    severity: ReviewFindingSeverity = "MEDIUM"
    id: str = field(default_factory=lambda: str(uuid.uuid4()))

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "lens": self.lens,
            "finding_type": self.finding_type,
            "description": self.description,
            "affected_belief_ids": list(self.affected_belief_ids),
            "affected_task_ids": list(self.affected_task_ids),
            "severity": self.severity,
        }


@dataclass
class AdversarialPrior:
    """Ephemeral adversarial prior — must never be serialised to HarnessRunState.

    Intentionally omits to_dict() / from_dict() to make persistence structurally
    impossible (INV-09).  Store only as a local variable inside reviewer_pass().
    """

    negated_beliefs: list[dict[str, Any]] = field(default_factory=list)
    seeded_from_failure_history: bool = False
    dep_class_gap_included: bool = False


@dataclass
class ReviewPassResult:
    findings: list[ReviewFinding] = field(default_factory=list)
    tasks_reopened: bool = False
    reopened_task_ids: list[str] = field(default_factory=list)
    abstraction_fit_score: float = 1.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "findings": [f.to_dict() for f in self.findings],
            "tasks_reopened": self.tasks_reopened,
            "reopened_task_ids": list(self.reopened_task_ids),
            "abstraction_fit_score": self.abstraction_fit_score,
        }


# ── P9.1 — Adversarial prior seeding ─────────────────────────────────────────


def compute_causal_proximity(
    belief_id: str,
    success_criteria: list[str],
    belief_dep_graph: Any,
) -> float:
    """Return causal proximity score in [0,1] for belief_id relative to success_criteria.

    Performs BFS from belief_id through the belief dependency graph (undirected)
    to find the shortest path to any belief node identified as a success criterion.
    Returns 1.0 / (shortest_path_length + 1).  Beliefs with no path score 0.0.

    Success-criteria nodes are identified by:
      1. Exact belief_id match against any string in success_criteria.
      2. Substring match of a success criterion against the node's description value
         in belief_dep_graph.belief_nodes.
    """
    belief_nodes: dict[str, str] = getattr(belief_dep_graph, "belief_nodes", {})
    edges = getattr(belief_dep_graph, "edges", [])

    sc_ids: set[str] = set()
    for criterion in success_criteria:
        # Only exact belief_id match — avoids false positives from substring overlap.
        if criterion in belief_nodes:
            sc_ids.add(criterion)

    if not sc_ids:
        return 0.0

    if belief_id in sc_ids:
        return 1.0

    # Build undirected adjacency
    adj: dict[str, list[str]] = {}
    for edge in edges:
        fid = getattr(edge, "from_id", None)
        tid = getattr(edge, "to_id", None)
        if fid and tid:
            adj.setdefault(fid, []).append(tid)
            adj.setdefault(tid, []).append(fid)

    visited: set[str] = {belief_id}
    queue: deque[tuple[str, int]] = deque([(belief_id, 0)])

    while queue:
        node, dist = queue.popleft()
        if node in sc_ids:
            return 1.0 / (dist + 1)
        for neighbor in adj.get(node, []):
            if neighbor not in visited:
                visited.add(neighbor)
                queue.append((neighbor, dist + 1))

    return 0.0


def _negate_statement(statement: str) -> str:
    low = statement.strip().lower()
    if low.startswith("not "):
        return statement.strip()[4:]
    return f"NOT: {statement}"


def seed_adversarial_prior(
    world_model: Any,
    success_criteria: list[str],
    failure_history: Any,
    dep_class_gap_annotation: Any = None,
    belief_dep_graph: Any = None,
    top_k: int = 5,
) -> AdversarialPrior:
    """Seed an AdversarialPrior by selecting beliefs causally proximal to success_criteria.

    Selection order: causal proximity (highest first), NOT raw confidence.
    The returned object must be stored only as a local variable — it has no
    serialisation methods (INV-09).
    """
    beliefs = getattr(world_model, "beliefs", [])

    # Step 1: compute proximity for each belief
    proximity_pairs: list[tuple[Any, float]] = []
    for belief in beliefs:
        prox = (
            compute_causal_proximity(belief.id, success_criteria, belief_dep_graph)
            if belief_dep_graph is not None
            else 0.0
        )
        proximity_pairs.append((belief, prox))

    # Step 2: sort by proximity descending, take top-K
    proximity_pairs.sort(key=lambda p: p[1], reverse=True)

    negated_beliefs: list[dict[str, Any]] = [
        {
            "belief_id": b.id,
            "negated_statement": _negate_statement(b.statement),
            "causal_proximity": prox,
        }
        for b, prox in proximity_pairs[:top_k]
        if prox > 0.0
    ]

    # Step 3: supplement from failure_history class priors (base_rate heuristic)
    seeded_from_failure = False
    fh_entries = []
    if failure_history is not None:
        fh_entries = getattr(failure_history, "failure_history", [])

    if fh_entries:
        class_counts: dict[str, int] = {}
        for entry in fh_entries:
            fc = getattr(entry, "failure_class", "")
            if fc:
                class_counts[fc] = class_counts.get(fc, 0) + 1

        # Classes with count >= 2 treated as base_rate > 0.3
        high_rate_classes = {fc for fc, cnt in class_counts.items() if cnt >= 2}
        already_seeded = {d["belief_id"] for d in negated_beliefs}

        if high_rate_classes:
            for belief in beliefs:
                if belief.id in already_seeded:
                    continue
                stmt = getattr(belief, "statement", "").lower()
                for fc in high_rate_classes:
                    fc_tokens = fc.lower().split("_")
                    if fc.lower() in stmt or any(tok in stmt for tok in fc_tokens):
                        negated_beliefs.append(
                            {
                                "belief_id": belief.id,
                                "negated_statement": _negate_statement(belief.statement),
                                "causal_proximity": 0.0,
                            }
                        )
                        already_seeded.add(belief.id)
                        seeded_from_failure = True
                        break

    # Step 4: dep_class_gap_annotation seeds
    dep_class_gap_included = False
    if dep_class_gap_annotation is not None:
        gap_belief_ids: list[str] = []
        if isinstance(dep_class_gap_annotation, dict):
            gap_belief_ids = dep_class_gap_annotation.get("belief_ids", [])
        else:
            gap_belief_ids = getattr(dep_class_gap_annotation, "belief_ids", [])

        if gap_belief_ids:
            dep_class_gap_included = True
            already_seeded = {d["belief_id"] for d in negated_beliefs}
            for bid in gap_belief_ids:
                if bid in already_seeded:
                    continue
                belief = next((b for b in beliefs if b.id == bid), None)
                stmt = belief.statement if belief else f"belief {bid}"
                negated_beliefs.append(
                    {
                        "belief_id": bid,
                        "negated_statement": _negate_statement(stmt),
                        "causal_proximity": 0.0,
                    }
                )

    return AdversarialPrior(
        negated_beliefs=negated_beliefs,
        seeded_from_failure_history=seeded_from_failure,
        dep_class_gap_included=dep_class_gap_included,
    )


# ── P9.2 — Three-lens reviewer pass ──────────────────────────────────────────


def implementer_lens(
    world_model: Any,
    task_graph: Any,
    success_criteria: list[str],
) -> list[ReviewFinding]:
    """Check task completion evidence, criteria coverage, and contradiction integrity.

    (a) Every COMPLETE task must have at least one observation referencing it.
    (b) All success_criteria must be covered by at least one COMPLETE task.
    (c) No COMPLETE task may have an open HIGH contradiction referencing its output.
    """
    findings: list[ReviewFinding] = []

    observations = getattr(world_model, "observations", [])
    contradictions = getattr(world_model, "contradictions", [])
    tasks = getattr(task_graph, "tasks", [])

    # Build set of observation content/source strings for fast lookup
    obs_content: list[str] = [
        (getattr(o, "content", "") + " " + getattr(o, "source", "")).lower() for o in observations
    ]

    for task in tasks:
        if getattr(task, "status", "") != "COMPLETE":
            continue
        tid = task.id

        # (a) No supporting observation
        has_obs = any(tid.lower() in oc for oc in obs_content)
        if not has_obs:
            findings.append(
                ReviewFinding(
                    lens="implementer",
                    finding_type="gap",
                    description=f"Task {tid!r} is COMPLETE but has no observation referencing it",
                    affected_task_ids=[tid],
                    severity="HIGH",
                )
            )

        # (c) Open HIGH contradiction referencing this task's output beliefs
        task_belief_ids: set[str] = set(getattr(task, "completed_evidence", []))
        for contra in contradictions:
            if getattr(contra, "severity", "") == "HIGH":
                involved = set(getattr(contra, "involved_belief_ids", []))
                if task_belief_ids & involved:
                    findings.append(
                        ReviewFinding(
                            lens="implementer",
                            finding_type="contradiction",
                            description=(
                                f"COMPLETE task {tid!r} has an open HIGH contradiction "
                                f"({contra.id}) referencing its evidence beliefs"
                            ),
                            affected_belief_ids=list(task_belief_ids & involved),
                            affected_task_ids=[tid],
                            severity="HIGH",
                        )
                    )

    # (b) success_criteria coverage
    complete_task_descriptions = " ".join(
        getattr(t, "description", "").lower() for t in tasks if getattr(t, "status", "") == "COMPLETE"
    )
    for criterion in success_criteria:
        criterion_tokens = set(criterion.lower().split())
        covered = bool(criterion_tokens & set(complete_task_descriptions.split()))
        if not covered:
            findings.append(
                ReviewFinding(
                    lens="implementer",
                    finding_type="gap",
                    description=f"Success criterion {criterion!r} is not covered by any COMPLETE task",
                    severity="MEDIUM",
                )
            )

    return findings


def reviewer_lens(
    world_model: Any,
    output_contract: Any,
    task_graph: Any,
    evidence_store: Any,
) -> list[ReviewFinding]:
    """Check output contract pre-conditions, unvalidated assumptions, and evidence gaps.

    (a) Required interface fields not produced by any COMPLETE task.
    (b) Assumptions not validated by any HIGH-reliability observation.
    (c) HIGH-reliability evidence that contradicts a belief but has no contradiction record.
    """
    findings: list[ReviewFinding] = []

    observations = getattr(world_model, "observations", [])
    beliefs = getattr(world_model, "beliefs", [])
    assumptions = getattr(world_model, "assumptions", [])
    contradictions = getattr(world_model, "contradictions", [])
    required_fields = getattr(output_contract, "required_interface_fields", []) if output_contract else []

    # (a) Required interface fields
    # Also include all observations for field presence check
    all_obs_content = " ".join(getattr(o, "content", "").lower() for o in observations)

    for field_name in required_fields:
        if field_name.lower() not in all_obs_content:
            findings.append(
                ReviewFinding(
                    lens="reviewer",
                    finding_type="contract_miss",
                    description=f"Required interface field {field_name!r} not found in any observation",
                    severity="HIGH",
                )
            )

    # (b) Unvalidated assumptions
    high_rel_obs = [
        getattr(o, "content", "").lower()
        for o in observations
        if getattr(o, "source", "").lower() in ("tool", "high", "verified")
    ]
    # Also check evidence_store entries
    if evidence_store is not None:
        entries = getattr(evidence_store, "entries", [])
        for entry in entries:
            if getattr(entry, "reliability", "") == "HIGH":
                high_rel_obs.append(getattr(entry, "obs", "").lower())

    for assumption in assumptions:
        assumption_lower = assumption.lower()
        assumption_tokens = set(assumption_lower.split())
        validated = any(bool(assumption_tokens & set(obs.split())) for obs in high_rel_obs)
        if not validated:
            findings.append(
                ReviewFinding(
                    lens="reviewer",
                    finding_type="assumption_violation",
                    description=f"Assumption {assumption!r} has no validating HIGH-reliability observation",
                    severity="MEDIUM",
                )
            )

    # (c) HIGH-reliability evidence contradicting beliefs without a contradiction record
    involved_in_contradictions: set[str] = set()
    for c in contradictions:
        involved_in_contradictions.update(getattr(c, "involved_belief_ids", []))

    if evidence_store is not None:
        entries = getattr(evidence_store, "entries", [])
        negation_keywords = {"no", "not", "absent", "missing", "failed", "none", "error"}
        for entry in entries:
            if getattr(entry, "reliability", "") != "HIGH":
                continue
            obs_words = set(getattr(entry, "obs", "").lower().split())
            for belief in beliefs:
                if belief.id in involved_in_contradictions:
                    continue
                stmt_words = set(belief.statement.lower().split())
                common = obs_words & stmt_words
                if common and (obs_words & negation_keywords):
                    findings.append(
                        ReviewFinding(
                            lens="reviewer",
                            finding_type="gap",
                            description=(
                                f"HIGH-reliability evidence contradicts belief {belief.id!r} "
                                "but no contradiction record exists"
                            ),
                            affected_belief_ids=[belief.id],
                            severity="MEDIUM",
                        )
                    )

    return findings


def adversarial_lens(
    world_model: Any,
    adversarial_prior: AdversarialPrior,
    hypothesis_set: Any,
    task_graph: Any,
) -> list[ReviewFinding]:
    """Challenge completed-task conclusions and hypothesis support using negated beliefs.

    For each negated belief in adversarial_prior:
    - If a COMPLETE task's evidence includes this belief, flag it as potentially invalid.
    - If an active hypothesis is ONLY supported by beliefs in the negated set, flag it.
    """
    findings: list[ReviewFinding] = []

    tasks = getattr(task_graph, "tasks", [])
    active_hypotheses = getattr(hypothesis_set, "active", []) if hypothesis_set else []

    negated_ids: set[str] = {d["belief_id"] for d in adversarial_prior.negated_beliefs}

    if not negated_ids:
        return findings

    # Check COMPLETE tasks whose completed_evidence overlaps with negated beliefs
    for task in tasks:
        if getattr(task, "status", "") != "COMPLETE":
            continue
        evidence_ids = set(getattr(task, "completed_evidence", []))
        invalidated = evidence_ids & negated_ids
        if invalidated:
            findings.append(
                ReviewFinding(
                    lens="adversarial",
                    finding_type="contradiction",
                    description=(
                        f"If adversarial prior holds, COMPLETE task {task.id!r} result "
                        f"is invalidated by negation of beliefs {sorted(invalidated)}"
                    ),
                    affected_belief_ids=list(invalidated),
                    affected_task_ids=[task.id],
                    severity="HIGH",
                )
            )

    # Check hypotheses only supported by negated beliefs
    all_beliefs = getattr(world_model, "beliefs", [])
    all_belief_ids = {b.id for b in all_beliefs}

    for hyp in active_hypotheses:
        discrim = set(getattr(hyp, "discriminating_evidence", []))
        # Only consider belief-id references (not observation ids)
        belief_support = discrim & all_belief_ids
        if belief_support and belief_support.issubset(negated_ids):
            findings.append(
                ReviewFinding(
                    lens="adversarial",
                    finding_type="assumption_violation",
                    description=(
                        f"Hypothesis {hyp.id!r} is only supported by beliefs in the "
                        "adversarial negation set — inadequately supported"
                    ),
                    affected_belief_ids=list(belief_support),
                    severity="MEDIUM",
                )
            )

    return findings


def reviewer_pass(
    world_model: Any,
    task_graph: Any,
    success_criteria: list[str],
    output_contract: Any,
    hypothesis_set: Any,
    evidence_store: Any,
    caller_state: Any,
    belief_dep_graph: Any,
    failure_history: Any,
    dep_class_gap_annotation: Any = None,
) -> ReviewPassResult:
    """Run the three-lens reviewer pass and return a ReviewPassResult.

    Sequence (INV-09 enforced — adversarial_prior goes out of scope after lenses):
      1. seed_adversarial_prior() — ephemeral local
      2. implementer_lens + reviewer_lens + adversarial_lens
      3. adversarial_prior goes out of scope
      4. Integrate HIGH-severity findings into world_model (observation first, INV-01)
      5. propagate_beliefs()
      6. update hypothesis_set + run elimination policy
      7. detect_contradictions()
      8. check_abstraction_alignment() — unconditional (force=True)
      9. drain_propagation_queue()
     10. Recompute diagnostics sub-dimensions
     11. Return ReviewPassResult
    """
    from .belief_graph import propagate_beliefs
    from .contradiction import detect_contradictions
    from .hypothesis import EliminationPolicy, eliminate
    from .task_graph import check_abstraction_alignment
    from .world_model import Belief, Observation

    sc_list: list[str] = list(success_criteria or [])
    if caller_state is not None:
        sc_list = list(getattr(caller_state, "success_criteria", sc_list) or sc_list)

    # ── Step 1: seed adversarial prior (ephemeral local) ───────────────────────
    adversarial_prior = seed_adversarial_prior(
        world_model=world_model,
        success_criteria=sc_list,
        failure_history=failure_history,
        dep_class_gap_annotation=dep_class_gap_annotation,
        belief_dep_graph=belief_dep_graph,
    )

    # ── Step 2: run all three lenses ──────────────────────────────────────────
    impl_findings = implementer_lens(world_model, task_graph, sc_list)
    rev_findings = reviewer_lens(world_model, output_contract, task_graph, evidence_store)
    adv_findings = adversarial_lens(world_model, adversarial_prior, hypothesis_set, task_graph)

    # ── Step 3: adversarial_prior goes out of scope here ─────────────────────
    del adversarial_prior

    all_findings: list[ReviewFinding] = impl_findings + rev_findings + adv_findings

    # ── Step 4: integrate HIGH findings into world_model (INV-01) ─────────────
    high_findings = [f for f in all_findings if f.severity == "HIGH"]
    for finding in high_findings:
        # First: add an Observation (the finding itself is an observed review outcome)
        obs_id = f"review_obs_{finding.id}"
        obs = Observation(
            id=obs_id,
            content=f"[{finding.lens}_lens] {finding.finding_type}: {finding.description}",
            source="reviewer_pass",
        )
        world_model.add_observation(obs)

        # Second: add a corrective Belief derived from the observation (INV-01)
        corrective_stmt = f"Corrective: {finding.description}"
        belief_id = f"review_belief_{finding.id}"
        corrective_belief = Belief(
            id=belief_id,
            statement=corrective_stmt,
            confidence=0.9,
            derived_from=[obs_id],
            supporting_evidence=[obs_id],
        )
        world_model.add_belief(corrective_belief)

        # Mark affected belief_ids as invalidated in the propagation queue
        if belief_dep_graph is not None and finding.affected_belief_ids:
            pq: list[str] = getattr(belief_dep_graph, "propagation_queue", [])
            for bid in finding.affected_belief_ids:
                if bid not in pq:
                    pq.append(bid)
            belief_dep_graph.propagation_queue = pq

    # ── Step 5: propagate_beliefs ─────────────────────────────────────────────
    if belief_dep_graph is not None:
        from .belief_graph import DepGraphBudget

        budget = DepGraphBudget()
        propagate_beliefs(belief_dep_graph, budget, world_model)

    # ── Step 6: update hypothesis_set + elimination policy ────────────────────
    if hypothesis_set is not None and evidence_store is not None:
        policy = EliminationPolicy()
        eliminate(hypothesis_set, evidence_store, {}, policy)

    # ── Step 7: detect_contradictions ─────────────────────────────────────────
    _es = evidence_store if evidence_store is not None else _make_empty_evidence_store()
    # detect_contradictions expects task_graph as dict or None
    _tg_dict = task_graph.to_dict() if (task_graph is not None and hasattr(task_graph, "to_dict")) else None
    new_contradictions = detect_contradictions(
        world_model=world_model,
        evidence_store=_es,
        hypothesis_set=hypothesis_set or _make_empty_hypothesis_set(),
        task_graph=_tg_dict,
    )
    for c in new_contradictions:
        already = any(ec.id == c.id for ec in world_model.contradictions)
        if not already:
            world_model.add_contradiction(c)

    # ── Step 8: check_abstraction_alignment (unconditional — INV-P9.2) ────────
    abstraction_score = check_abstraction_alignment(task_graph, world_model, force=True)

    # ── Step 9: drain_propagation_queue ───────────────────────────────────────
    reopened_ids = drain_propagation_queue(belief_dep_graph, task_graph)

    return ReviewPassResult(
        findings=all_findings,
        tasks_reopened=bool(reopened_ids),
        reopened_task_ids=reopened_ids,
        abstraction_fit_score=abstraction_score,
    )


# ── P9.3 — drain_propagation_queue + task re-open ────────────────────────────


def drain_propagation_queue(
    belief_dep_graph: Any,
    task_graph: Any,
) -> list[str]:
    """Drain the belief_dep_graph propagation_queue and reopen affected COMPLETE tasks.

    For each belief_id in the propagation_queue: finds COMPLETE tasks whose
    completed_evidence list includes that belief_id, transitions them to PENDING,
    and clears their completed_evidence.  Clears the propagation_queue.

    Returns the list of task_ids that were reopened (may be empty).
    Only COMPLETE tasks are subject to re-open — FAILED, BLOCKED, ACTIVE, or
    PENDING tasks are left in their current status.
    """
    if belief_dep_graph is None:
        return []

    pq: list[str] = list(getattr(belief_dep_graph, "propagation_queue", []))
    if not pq:
        return []

    # Clear the queue
    belief_dep_graph.propagation_queue = []

    if task_graph is None:
        return []

    tasks = getattr(task_graph, "tasks", [])
    invalidated_beliefs: set[str] = set(pq)
    reopened: list[str] = []

    for task in tasks:
        if getattr(task, "status", "") != "COMPLETE":
            continue
        evidence_ids: set[str] = set(getattr(task, "completed_evidence", []))
        if evidence_ids & invalidated_beliefs:
            # Transition COMPLETE → PENDING (P9 reviewer pass special case — INV-task-graph)
            task.status = "PENDING"
            task.completed_evidence = []
            task_graph.changed = True
            reopened.append(task.id)

    return reopened


# ── Helpers ───────────────────────────────────────────────────────────────────


def _make_empty_evidence_store() -> Any:
    from .evidence import EvidenceStore

    return EvidenceStore()


def _make_empty_hypothesis_set() -> Any:
    from .hypothesis import HypothesisSet

    return HypothesisSet()
