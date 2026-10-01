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

from ._core_generated import EXECUTION_RATIO_MIN_ATTEMPTS

DimensionType = Literal["ratio", "composite", "entropy", "match_confidence"]

# Provenance of a diagnostic sub-dimension value (INV-11 — criticism001 #3;
# ADR-004, shared semantic core). Mirrors packages/harness/src/state/diagnostics.ts.
#   deterministic — computed from world-model / evidence counts (all ten today)
#   model         — an LLM-derived estimate
#   heuristic     — a hand-tuned rule of thumb
#   default       — nothing stamped one; the fill default
DimensionSource = Literal["deterministic", "model", "heuristic", "default"]


class NormalisationError(Exception):
    """Raised when a value outside [0,1] attempts to enter tier arithmetic."""


@dataclass
class DimensionProvenance:
    """Where a diagnostic sub-dimension value came from, so an LLM-derived 0.72 and a
    deterministically-computed 0.72 do not enter the resolver with equal authority (INV-11)."""

    source: DimensionSource = "deterministic"
    calibrated: bool = False  # is there a calibration curve behind `source: model`?
    evidence_ids: list[str] = field(default_factory=list)  # EvidenceStore ids this was computed from

    def to_dict(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "calibrated": self.calibrated,
            "evidence_ids": list(self.evidence_ids),
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> DimensionProvenance:
        return cls(
            source=d.get("source", "deterministic"),
            calibrated=bool(d.get("calibrated", False)),
            evidence_ids=list(d.get("evidence_ids") or []),
        )


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
    symptom_coverage: float = 0.5  # entropy: fraction of symptoms with a hypothesis
    explanation_coverage: float = 0.5  # entropy: fraction of hypotheses with discriminating evidence

    def to_dict(self) -> dict[str, Any]:
        return {
            "symptom_coverage": self.symptom_coverage,
            "explanation_coverage": self.explanation_coverage,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> CoverageHealth:
        return cls(
            symptom_coverage=d.get("symptom_coverage", 0.5),
            explanation_coverage=d.get("explanation_coverage", 0.5),
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
    # INV-11: provenance for each of the ten sub-dimension names. May be sparse on
    # construction; ensure_provenance() (called by resolve_control_state) fills any
    # missing name with the deterministic default before the resolver reads it.
    provenance: dict[str, DimensionProvenance] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "belief_health": self.belief_health.to_dict(),
            "coverage_health": self.coverage_health.to_dict(),
            "verification_health": self.verification_health.to_dict(),
            "execution_health": self.execution_health.to_dict(),
            "dep_class_gap_annotation": self.dep_class_gap_annotation or "",
            "provenance": {k: v.to_dict() for k, v in self.provenance.items()},
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Diagnostics:
        return cls(
            belief_health=BeliefHealth.from_dict(d.get("belief_health") or {}),
            coverage_health=CoverageHealth.from_dict(d.get("coverage_health") or {}),
            verification_health=VerificationHealth.from_dict(d.get("verification_health") or {}),
            execution_health=ExecutionHealth.from_dict(d.get("execution_health") or {}),
            dep_class_gap_annotation=d.get("dep_class_gap_annotation"),
            provenance={k: DimensionProvenance.from_dict(v) for k, v in (d.get("provenance") or {}).items()},
        )


_RELIABILITY_WEIGHT: dict[str, float] = {"HIGH": 1.0, "MEDIUM": 0.5, "LOW": 0.0}


def _dep_class_gap_annotation(task_graph: Any) -> str:
    levels = sorted({t.abstraction_level for t in task_graph.tasks})
    if len(levels) <= 1:
        return ""
    gaps = [
        f"gap between level {levels[i - 1]} and {levels[i]}"
        for i in range(1, len(levels))
        if levels[i] - levels[i - 1] > 1
    ]
    return f"Abstraction class gaps detected: {', '.join(gaps)}" if gaps else ""


def update_diagnostics(
    world_model: Any,
    hypothesis_set: Any,
    task_graph: Any,
    failure_diagnostics: Any,
    dep_graph: Any,
    diagnostics: Diagnostics,
    force: bool = False,
) -> None:
    """Recompute every sub-dimension from current state in a single pass (TS updateDiagnostics).

    * belief_health: freshness = 1 - stale/beliefs; consistency = 1 - min(1, contradictions/beliefs); support =
      mean reliability weight (HIGH 1.0 / MEDIUM 0.5 / LOW 0.0; default MEDIUM);
    * coverage_health: symptom_coverage = min(1, #active hypotheses / max(#observations, 1)); explanation_coverage
      = source-entropy of the active hypotheses;
    * verification_health: strength = 1 - dep_graph.unverified_edge_ratio; feasibility = composite of tool adequacy,
      evidence adequacy and abstraction fit (weights 1, 1, 0.3);
    * execution_health (over the task graph): progress_rate = complete / attempted once attempted >=
      EXECUTION_RATIO_MIN_ATTEMPTS (else neutral 1.0); failure_recurrence = min(1, failures / 10); oscillation =
      failed / total (same minimum sample);
    * matched_pattern from the failure-mode library over the world model's observations, and the advisory
      dep_class_gap_annotation.

    `force=True` makes check_abstraction_alignment recompute even when the task graph is unchanged (reviewer pass).
    """
    from .hypothesis import compute_source_entropy
    from .task_graph import check_abstraction_alignment

    belief_count = len(world_model.beliefs)

    # belief_health
    stale_ratio = sum(1 for v in world_model.stale_flags.values() if v) / max(1, belief_count)
    freshness = normalise(1 - stale_ratio, "ratio")
    assert_normalised(freshness, "belief_health.freshness")

    density = min(1.0, len(world_model.contradictions) / belief_count) if belief_count > 0 else 0.0
    consistency = normalise(1 - density, "ratio")
    assert_normalised(consistency, "belief_health.consistency")

    mean_support = (
        sum(_RELIABILITY_WEIGHT.get(b.reliability or "MEDIUM", 0.5) for b in world_model.beliefs) / belief_count
        if belief_count > 0
        else 1.0
    )
    support = normalise(mean_support, "ratio")
    assert_normalised(support, "belief_health.support")

    diagnostics.belief_health.freshness = freshness
    diagnostics.belief_health.consistency = consistency
    diagnostics.belief_health.support = support

    # coverage_health
    n_active = len(hypothesis_set.active)
    symptom_coverage = normalise(
        min(1.0, n_active / max(len(world_model.observations), 1)) if n_active > 0 else 0.0, "ratio"
    )
    assert_normalised(symptom_coverage, "coverage_health.symptom_coverage")
    explanation_coverage = normalise(compute_source_entropy(hypothesis_set), "ratio")
    assert_normalised(explanation_coverage, "coverage_health.explanation_coverage")
    diagnostics.coverage_health.symptom_coverage = symptom_coverage
    diagnostics.coverage_health.explanation_coverage = explanation_coverage

    # verification_health
    strength = normalise(1 - dep_graph.unverified_edge_ratio, "ratio")
    assert_normalised(strength, "verification_health.strength")

    abstraction_fit = check_abstraction_alignment(task_graph, world_model, force)
    tool_adequacy = normalise(0.8 if world_model.completeness_flags else 0.6, "ratio")
    evidence_adequacy = normalise(0.8 if world_model.observations else 0.4, "ratio")
    feasibility = normalise(
        {"components": [tool_adequacy, evidence_adequacy, abstraction_fit], "weights": [1, 1, 0.3]}, "composite"
    )
    assert_normalised(feasibility, "verification_health.feasibility")
    diagnostics.verification_health.strength = strength
    diagnostics.verification_health.feasibility = feasibility

    # execution_health — success rate of tasks *attempted* so far, neutral below the minimum sample so a single
    # failed attempt of a single-task turn (0/1 = 0) cannot trip Tier 2 before recovery can retry once.
    total_tasks = len(task_graph.tasks)
    completed = sum(1 for t in task_graph.tasks if t.status == "COMPLETE")
    failed = sum(1 for t in task_graph.tasks if t.status == "FAILED")
    attempted = completed + failed
    enough = attempted >= EXECUTION_RATIO_MIN_ATTEMPTS

    progress_rate = normalise(completed / attempted if enough else 1.0, "ratio")
    assert_normalised(progress_rate, "execution_health.progress_rate")
    failure_recurrence = normalise(min(1.0, len(failure_diagnostics.failure_history) / 10), "ratio")
    assert_normalised(failure_recurrence, "execution_health.failure_recurrence")
    oscillation = normalise(failed / total_tasks if total_tasks > 0 and enough else 0.0, "ratio")
    assert_normalised(oscillation, "execution_health.oscillation_score")
    diagnostics.execution_health.progress_rate = progress_rate
    diagnostics.execution_health.failure_recurrence = failure_recurrence
    diagnostics.execution_health.oscillation_score = oscillation

    # failure_mode_library match over the observed symptoms
    from .failure_modes import MatchResult

    match = failure_diagnostics.failure_mode_library.match([o.content for o in world_model.observations])
    if match is not None:
        failure_diagnostics.matched_pattern = MatchResult(
            failure_class=match.failure_class,
            confidence=normalise(match.confidence, "match_confidence"),
            matched_pattern=match.matched_pattern,
            strategy_affinity=match.strategy_affinity,
        )
    else:
        failure_diagnostics.matched_pattern = None

    # dep_class_gap_annotation: advisory string only — never a numeric input to any tier
    diagnostics.dep_class_gap_annotation = _dep_class_gap_annotation(task_graph)


# ── Normalisation contract (INV-02) ───────────────────────────────────────────


def normalise_ratio(raw: float) -> float:
    return max(0.0, min(1.0, raw))


def normalise_composite(raw: float, weights: list[float], components: list[float]) -> float:
    total_weight = sum(weights)
    if total_weight == 0:
        return 0.0
    weighted_sum = sum(w * c for w, c in zip(weights, components, strict=False))
    return max(0.0, min(1.0, weighted_sum / total_weight))


def normalise_entropy(source_counts: dict[str, int] | list[int] | list[float]) -> float:
    """Compute normalised Shannon entropy over a source frequency distribution (a dict of counts or, as the
    TS twin takes it, a plain list of counts)."""
    counts = list(source_counts.values()) if isinstance(source_counts, dict) else list(source_counts)
    num_sources = len(counts)
    if num_sources < 2:
        return 0.0
    total = sum(counts)
    if total == 0:
        return 0.0
    probs = [count / total for count in counts]
    entropy = -sum(p * math.log2(p) for p in probs if p > 0)
    max_entropy = math.log2(num_sources)
    if max_entropy == 0:
        return 0.0
    return max(0.0, min(1.0, entropy / max_entropy))


def normalise_match_confidence(raw: float) -> float:
    return max(0.0, min(1.0, raw))


def normalise(raw_value: Any, dimension_type: DimensionType, **kwargs: Any) -> float:
    """Dispatch to the correct normalisation method for the given dimension type.

    All calls to tier 4 arithmetic must pass through this function — never
    call sub-methods directly (INV-02).

    Accepts the TS `normalise(raw, type)` input forms as well as the keyword form: a `composite` raw value may
    be `{"components": [...], "weights": [...]}` and an `entropy` raw value a list of counts.
    """
    if dimension_type == "ratio":
        return normalise_ratio(raw_value)
    elif dimension_type == "composite":
        if isinstance(raw_value, dict):
            return normalise_composite(0.0, list(raw_value["weights"]), list(raw_value["components"]))
        weights: list[float] = kwargs.get("weights", [1.0])
        components: list[float] = kwargs.get("components", [raw_value])
        return normalise_composite(raw_value, weights, components)
    elif dimension_type == "entropy":
        if isinstance(raw_value, (list, tuple)):
            return normalise_entropy(list(raw_value))
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
