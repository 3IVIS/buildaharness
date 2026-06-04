"""
Diagnostic health vectors and normalisation contract — P3.1 and P3.2.

Four typed health vector dataclasses with ten normalised sub-dimensions.
update_diagnostics() recomputes all sub-dimensions in a single pass.
normalise() provides the dimension-specific normalisation contract (INV-02).
assert_normalised() enforces the [0,1] contract at every tier call site.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Literal

DimensionType = Literal["ratio", "composite", "entropy", "match_confidence"]


class NormalisationError(Exception):
    """Raised when a value outside [0,1] attempts to enter tier arithmetic."""


# ── Health vector dataclasses (P3.1) ─────────────────────────────────────────


@dataclass
class BeliefHealth:
    freshness: float = 1.0  # ratio: 1 - stale_flag_ratio
    consistency: float = 1.0  # ratio: 1 - contradiction_density
    support: float = 1.0  # ratio: mean reliability weight over beliefs

    def to_dict(self) -> dict[str, Any]:
        return {
            "freshness": self.freshness,
            "consistency": self.consistency,
            "support": self.support,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> BeliefHealth:
        return cls(
            freshness=d.get("freshness", 1.0),
            consistency=d.get("consistency", 1.0),
            support=d.get("support", 1.0),
        )


@dataclass
class CoverageHealth:
    symptom_coverage: float = 1.0  # entropy: fraction of symptoms with a hypothesis
    explanation_coverage: float = 1.0  # entropy: fraction of hypotheses with discriminating evidence

    def to_dict(self) -> dict[str, Any]:
        return {
            "symptom_coverage": self.symptom_coverage,
            "explanation_coverage": self.explanation_coverage,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> CoverageHealth:
        return cls(
            symptom_coverage=d.get("symptom_coverage", 1.0),
            explanation_coverage=d.get("explanation_coverage", 1.0),
        )


@dataclass
class VerificationHealth:
    strength: float = 1.0  # ratio: fraction of 9 verification layers passing (P5.5)
    feasibility: float = 1.0  # composite: abstraction alignment + tool availability + VOI (P4.4/P5.2)

    def to_dict(self) -> dict[str, Any]:
        return {
            "strength": self.strength,
            "feasibility": self.feasibility,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> VerificationHealth:
        return cls(
            strength=d.get("strength", 1.0),
            feasibility=d.get("feasibility", 1.0),
        )


@dataclass
class ExecutionHealth:
    progress_rate: float = 1.0  # ratio: tasks_completed / total_tasks this iteration
    failure_recurrence: float = 0.0  # composite: fraction of iterations ending in same failure
    oscillation_score: float = 0.0  # composite: fraction of risk_state transitions that are reversals

    def to_dict(self) -> dict[str, Any]:
        return {
            "progress_rate": self.progress_rate,
            "failure_recurrence": self.failure_recurrence,
            "oscillation_score": self.oscillation_score,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> ExecutionHealth:
        return cls(
            progress_rate=d.get("progress_rate", 1.0),
            failure_recurrence=d.get("failure_recurrence", 0.0),
            oscillation_score=d.get("oscillation_score", 0.0),
        )


@dataclass
class Diagnostics:
    belief_health: BeliefHealth = field(default_factory=BeliefHealth)
    coverage_health: CoverageHealth = field(default_factory=CoverageHealth)
    verification_health: VerificationHealth = field(default_factory=VerificationHealth)
    execution_health: ExecutionHealth = field(default_factory=ExecutionHealth)
    # Advisory string only — never a numeric sub-dimension (INV-07)
    dep_class_gap_annotation: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "belief_health": self.belief_health.to_dict(),
            "coverage_health": self.coverage_health.to_dict(),
            "verification_health": self.verification_health.to_dict(),
            "execution_health": self.execution_health.to_dict(),
            "dep_class_gap_annotation": self.dep_class_gap_annotation,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Diagnostics:
        return cls(
            belief_health=BeliefHealth.from_dict(d.get("belief_health") or {}),
            coverage_health=CoverageHealth.from_dict(d.get("coverage_health") or {}),
            verification_health=VerificationHealth.from_dict(d.get("verification_health") or {}),
            execution_health=ExecutionHealth.from_dict(d.get("execution_health") or {}),
            dep_class_gap_annotation=d.get("dep_class_gap_annotation"),
        )


def update_diagnostics(
    diagnostics: Diagnostics,
    world_model: Any,
    hypothesis_set: Any,
    evidence_store: Any,
    task_graph: Any | None = None,
    execution_journal: list[dict[str, Any]] | None = None,
    force: bool = False,
) -> None:
    """Recompute all ten sub-dimensions from current system state in a single pass.

    force=True causes check_abstraction_alignment to run regardless of
    task_graph.changed — used by the P9 reviewer pass.
    """
    execution_journal = execution_journal or []

    # ── belief_health ────────────────────────────────────────────────────────
    stale_flag_ratio: float = getattr(world_model, "stale_flag_ratio", 0.0)
    diagnostics.belief_health.freshness = max(0.0, min(1.0, 1.0 - stale_flag_ratio))

    belief_count = max(1, len(world_model.beliefs))
    contradiction_density = len(world_model.contradictions) / belief_count
    diagnostics.belief_health.consistency = max(0.0, min(1.0, 1.0 - contradiction_density))

    proxies: dict[str, float] = getattr(world_model, "belief_health_proxies", {})
    diagnostics.belief_health.support = proxies.get("support", 1.0)

    # ── coverage_health ──────────────────────────────────────────────────────
    hypotheses = getattr(hypothesis_set, "hypotheses", [])

    all_symptoms: set[str] = set()
    explained_symptoms: set[str] = set()
    for h in hypotheses:
        for s in getattr(h, "target_symptoms", []):
            all_symptoms.add(s)
            explained_symptoms.add(s)
    if hasattr(evidence_store, "entries"):
        for e in evidence_store.entries:
            tag = getattr(e, "symptom_tag", None)
            if tag:
                all_symptoms.add(tag)

    diagnostics.coverage_health.symptom_coverage = len(explained_symptoms) / len(all_symptoms) if all_symptoms else 1.0

    if hypotheses:
        covered = sum(
            1
            for h in hypotheses
            if getattr(h, "discriminating_evidence", None) or getattr(h, "supporting_evidence", [])
        )
        diagnostics.coverage_health.explanation_coverage = covered / len(hypotheses)
    else:
        diagnostics.coverage_health.explanation_coverage = 1.0

    # ── verification_health ───────────────────────────────────────────────────
    # strength is updated by P5.5; feasibility gets a 0.3-weighted contribution
    # from abstraction alignment (P4.4) when the task graph has changed.
    if task_graph is not None and (force or getattr(task_graph, "changed", False)):
        from .task_graph import check_abstraction_alignment  # avoid circular import

        alignment_score = check_abstraction_alignment(task_graph, world_model, force=True)
        current_feasibility = diagnostics.verification_health.feasibility
        diagnostics.verification_health.feasibility = max(
            0.0, min(1.0, 0.3 * alignment_score + 0.7 * current_feasibility)
        )

    # ── execution_health ─────────────────────────────────────────────────────
    if execution_journal:
        total = len(execution_journal)
        completed = sum(1 for e in execution_journal if e.get("status") == "completed")
        diagnostics.execution_health.progress_rate = completed / max(1, total)

        failure_modes = [e.get("failure_mode") for e in execution_journal if e.get("failure_mode")]
        if failure_modes:
            most_common = max(failure_modes.count(m) for m in set(failure_modes))
            diagnostics.execution_health.failure_recurrence = most_common / len(failure_modes)
        else:
            diagnostics.execution_health.failure_recurrence = 0.0

        risk_states = [e.get("risk_state") for e in execution_journal if e.get("risk_state")]
        if len(risk_states) >= 2:
            reversals = sum(1 for i in range(1, len(risk_states)) if risk_states[i] != risk_states[i - 1])
            diagnostics.execution_health.oscillation_score = reversals / (len(risk_states) - 1)
        else:
            diagnostics.execution_health.oscillation_score = 0.0


# ── Normalisation contract (INV-02) ───────────────────────────────────────────


def normalise_ratio(raw: float) -> float:
    return max(0.0, min(1.0, raw))


def normalise_composite(raw: float, weights: list[float], components: list[float]) -> float:
    total_weight = sum(weights)
    if total_weight == 0:
        return 0.0
    weighted_sum = sum(w * c for w, c in zip(weights, components, strict=False))
    return max(0.0, min(1.0, weighted_sum / total_weight))


def normalise_entropy(source_counts: dict[str, int]) -> float:
    """Compute normalised Shannon entropy over a source frequency distribution."""
    num_sources = len(source_counts)
    if num_sources < 2:
        return 0.0
    total = sum(source_counts.values())
    if total == 0:
        return 0.0
    probs = [count / total for count in source_counts.values()]
    entropy = -sum(p * math.log2(p) for p in probs if p > 0)
    max_entropy = math.log2(num_sources)
    if max_entropy == 0:
        return 0.0
    return max(0.0, min(1.0, entropy / max_entropy))


def normalise_match_confidence(raw: float) -> float:
    return max(0.0, min(1.0, raw))


def normalise(raw_value: float, dimension_type: DimensionType, **kwargs: Any) -> float:
    """Dispatch to the correct normalisation method for the given dimension type.

    All calls to tier 4 arithmetic must pass through this function — never
    call sub-methods directly (INV-02).
    """
    if dimension_type == "ratio":
        return normalise_ratio(raw_value)
    elif dimension_type == "composite":
        weights: list[float] = kwargs.get("weights", [1.0])
        components: list[float] = kwargs.get("components", [raw_value])
        return normalise_composite(raw_value, weights, components)
    elif dimension_type == "entropy":
        source_counts: dict[str, int] = kwargs.get("source_counts", {})
        return normalise_entropy(source_counts)
    elif dimension_type == "match_confidence":
        return normalise_match_confidence(raw_value)
    else:
        raise ValueError(f"Unknown dimension type: {dimension_type!r}")


def assert_normalised(value: float, label: str) -> float:
    """Assert value is in [0,1]; raise NormalisationError otherwise."""
    if value < 0.0 or value > 1.0:
        raise NormalisationError(f"{label} value {value} is outside [0,1]")
    return value
