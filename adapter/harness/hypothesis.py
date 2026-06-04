"""
Hypothesis data model, generation sources, elimination policy, and
diversity enforcement — P1.6 and P1.7.

Four structurally distinct generation sources ensure diverse hypothesis sets.
Elimination moves hypotheses to a bounded retained set (K-retention).
Shannon entropy over sources drives diversity enforcement.
"""

from __future__ import annotations

import math
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, Literal

from .evidence import EvidenceStore

if TYPE_CHECKING:
    from .world_model import WorldModel

EliminationReason = Literal[
    "CONTRADICTING_EVIDENCE",
    "PREDICTION_FAILURE",
    "POSTERIOR_BELOW_FLOOR",
]


@dataclass
class Hypothesis:
    id: str
    explanation: str
    confidence: float
    predicted_observations: list[str]
    discriminating_evidence: list[str]
    generation_sources: list[str]

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "explanation": self.explanation,
            "confidence": self.confidence,
            "predicted_observations": list(self.predicted_observations),
            "discriminating_evidence": list(self.discriminating_evidence),
            "generation_sources": list(self.generation_sources),
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Hypothesis:
        return cls(
            id=d["id"],
            explanation=d["explanation"],
            confidence=d["confidence"],
            predicted_observations=d.get("predicted_observations", []),
            discriminating_evidence=d.get("discriminating_evidence", []),
            generation_sources=d.get("generation_sources", []),
        )


@dataclass
class EliminationRecord:
    hypothesis_id: str
    reason: EliminationReason
    eliminated_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    def to_dict(self) -> dict[str, Any]:
        return {
            "hypothesis_id": self.hypothesis_id,
            "reason": self.reason,
            "eliminated_at": self.eliminated_at.isoformat(),
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> EliminationRecord:
        return cls(
            hypothesis_id=d["hypothesis_id"],
            reason=d["reason"],
            eliminated_at=datetime.fromisoformat(d["eliminated_at"]) if "eliminated_at" in d else datetime.now(UTC),
        )


@dataclass
class HypothesisSet:
    active: list[Hypothesis] = field(default_factory=list)
    eliminated: list[tuple[Hypothesis, EliminationRecord]] = field(default_factory=list)
    diversity_score: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "active": [h.to_dict() for h in self.active],
            "eliminated": [{"hypothesis": h.to_dict(), "record": r.to_dict()} for h, r in self.eliminated],
            "diversity_score": self.diversity_score,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> HypothesisSet:
        hs = cls(diversity_score=d.get("diversity_score", 0.0))
        for item in d.get("active", []):
            hs.active.append(Hypothesis.from_dict(item))
        for item in d.get("eliminated", []):
            h = Hypothesis.from_dict(item["hypothesis"])
            r = EliminationRecord.from_dict(item["record"])
            hs.eliminated.append((h, r))
        return hs


@dataclass
class EliminationPolicy:
    """
    Constants for hypothesis elimination and diversity enforcement.

    prediction_failure_threshold=3: three missed predictions before elimination
    posterior_floor=0.05: hypotheses below 5% confidence are implausible noise
    k_retention=20: keeps a bounded audit trail of eliminated hypotheses
    diversity_threshold=0.7: normalised Shannon entropy target over sources
    max_diversity_passes=3: safety cap to prevent infinite generation loops
    """

    prediction_failure_threshold: int = 3
    posterior_floor: float = 0.05
    k_retention: int = 20
    diversity_threshold: float = 0.7
    max_diversity_passes: int = 3

    def to_dict(self) -> dict[str, Any]:
        return {
            "prediction_failure_threshold": self.prediction_failure_threshold,
            "posterior_floor": self.posterior_floor,
            "k_retention": self.k_retention,
            "diversity_threshold": self.diversity_threshold,
            "max_diversity_passes": self.max_diversity_passes,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> EliminationPolicy:
        return cls(
            prediction_failure_threshold=d.get("prediction_failure_threshold", 3),
            posterior_floor=d.get("posterior_floor", 0.05),
            k_retention=d.get("k_retention", 20),
            diversity_threshold=d.get("diversity_threshold", 0.7),
            max_diversity_passes=d.get("max_diversity_passes", 3),
        )


# ── Generation sources (P1.6) ─────────────────────────────────────────────────


def symptom_inference(
    world_model: WorldModel,
    evidence_store: EvidenceStore,
) -> list[Hypothesis]:
    """Generate hypotheses by clustering raw observations via word-overlap."""
    observations = evidence_store.query(evidence_type="OBSERVATION")
    all_texts = [e.obs for e in observations] + [o.content for o in world_model.observations]

    if not all_texts:
        return []

    used = [False] * len(all_texts)
    clusters: list[list[str]] = []

    for i, text_i in enumerate(all_texts):
        if used[i]:
            continue
        cluster = [text_i]
        words_i = set(text_i.lower().split())
        for j in range(i + 1, len(all_texts)):
            if used[j]:
                continue
            words_j = set(all_texts[j].lower().split())
            if words_i and words_j:
                jaccard = len(words_i & words_j) / len(words_i | words_j)
                if jaccard > 0.2:
                    cluster.append(all_texts[j])
                    used[j] = True
        used[i] = True
        clusters.append(cluster)

    return [
        Hypothesis(
            id=str(uuid.uuid4()),
            explanation=f"Symptom cluster: {cluster[0][:80]}",
            confidence=0.5,
            predicted_observations=cluster,
            discriminating_evidence=[],
            generation_sources=["symptom_inference"],
        )
        for cluster in clusters
    ]


def counterfactual_reasoning(world_model: WorldModel) -> list[Hypothesis]:
    """Generate counterfactual alternatives for each high-confidence belief."""
    if not world_model.beliefs:
        return []

    return [
        Hypothesis(
            id=str(uuid.uuid4()),
            explanation=f"Counterfactual: alternative explanation for '{belief.statement[:80]}'",
            confidence=0.3,
            predicted_observations=[],
            discriminating_evidence=list(belief.derived_from),
            generation_sources=["counterfactual_reasoning"],
        )
        for belief in world_model.beliefs
        if belief.confidence >= 0.6
    ]


def failure_mode_library_contribution(fml_stub: dict | None) -> list[Hypothesis]:
    """Generate hypotheses from the failure mode library stub (advisory only).

    Never writes to any control structure — return type is list[Hypothesis] only.
    Enforces INV-08: the library is advisory, never blocking.
    """
    if not fml_stub:
        return []

    return [
        Hypothesis(
            id=str(uuid.uuid4()),
            explanation=str(description),
            confidence=0.2,
            predicted_observations=[],
            discriminating_evidence=[],
            generation_sources=["failure_mode_library"],
        )
        for description in fml_stub.values()
    ]


def generate_from_failure_library(
    world_model: WorldModel,
    failure_mode_library: Any,
) -> list[Hypothesis]:
    """Generate hypotheses from the typed FailureModeLibrary (generation source 3 — P6.3).

    Returns an empty list if the library is None or no pattern matches.
    The returned hypothesis records generation_sources=["failure_mode_library"] so
    diversity enforcement can account for this source independently.
    """
    if failure_mode_library is None:
        return []

    match_result = failure_mode_library.match(world_model, None, None)
    if not getattr(match_result, "matched", False):
        return []

    template = ""
    for pattern in getattr(failure_mode_library, "patterns", ()):
        if getattr(pattern, "name", "") == getattr(match_result, "pattern_name", ""):
            template = getattr(pattern, "hypothesis_template", "")
            break

    if not template:
        return []

    return [
        Hypothesis(
            id=str(uuid.uuid4()),
            explanation=template,
            confidence=getattr(match_result, "normalised_confidence", 0.2),
            predicted_observations=[],
            discriminating_evidence=[],
            generation_sources=["failure_mode_library"],
        )
    ]


def analogy_based_generation(experience_store: Any) -> list[Hypothesis]:
    """Generate hypotheses from past experience analogies.

    Guard on line 1 is the canonical INV-10 no-op pattern — callers in all
    later phases that use the experience store must replicate this guard.
    """
    if experience_store is None or not getattr(experience_store, "available", False):
        return []

    hypotheses = []
    try:
        decompositions = getattr(experience_store, "successful_decompositions", [])
        for decomp in decompositions:
            hypotheses.append(
                Hypothesis(
                    id=str(uuid.uuid4()),
                    explanation=f"Analogy from past experience: {str(decomp)[:80]}",
                    confidence=0.4,
                    predicted_observations=[],
                    discriminating_evidence=[],
                    generation_sources=["analogy_based"],
                )
            )
    except Exception:
        pass
    return hypotheses


def _jaccard(a: str, b: str) -> float:
    wa = set(a.lower().split())
    wb = set(b.lower().split())
    if not wa or not wb:
        return 0.0
    return len(wa & wb) / len(wa | wb)


def generate_hypotheses(
    world_model: WorldModel,
    evidence_store: EvidenceStore,
    fml_stub: dict | None = None,
    experience_store: Any = None,
) -> list[Hypothesis]:
    """Collect from all four sources, deduplicate by explanation word-overlap."""
    all_hypotheses: list[Hypothesis] = []
    all_hypotheses.extend(symptom_inference(world_model, evidence_store))
    all_hypotheses.extend(counterfactual_reasoning(world_model))
    all_hypotheses.extend(failure_mode_library_contribution(fml_stub))
    all_hypotheses.extend(analogy_based_generation(experience_store))

    used = [False] * len(all_hypotheses)
    merged: list[Hypothesis] = []

    for i, h_i in enumerate(all_hypotheses):
        if used[i]:
            continue
        combined_sources = list(h_i.generation_sources)
        for j in range(i + 1, len(all_hypotheses)):
            if used[j]:
                continue
            if _jaccard(h_i.explanation, all_hypotheses[j].explanation) > 0.8:
                for src in all_hypotheses[j].generation_sources:
                    if src not in combined_sources:
                        combined_sources.append(src)
                used[j] = True
        used[i] = True
        merged.append(
            Hypothesis(
                id=str(uuid.uuid4()),
                explanation=h_i.explanation,
                confidence=h_i.confidence,
                predicted_observations=h_i.predicted_observations,
                discriminating_evidence=h_i.discriminating_evidence,
                generation_sources=combined_sources,
            )
        )

    return merged


# ── Elimination policy (P1.7) ─────────────────────────────────────────────────


def check_contradicting_evidence(
    hypothesis: Hypothesis,
    evidence_store: EvidenceStore,
) -> bool:
    """Return True if any HIGH-reliability evidence contradicts a predicted observation."""
    _negation_keywords = {"no", "not", "absent", "missing", "failed", "none", "error", "unavailable"}

    for entry in evidence_store.entries:
        if entry.reliability != "HIGH":
            continue
        if entry.evidence_type not in ("OBSERVATION", "INFERENCE"):
            continue
        obs_words = set(entry.obs.lower().split())
        for predicted in hypothesis.predicted_observations:
            pred_words = set(predicted.lower().split())
            if not pred_words:
                continue
            common = obs_words & pred_words
            if common and (obs_words & _negation_keywords):
                return True
    return False


def check_prediction_failure(
    hypothesis: Hypothesis,
    failure_counts: dict[str, int],
    policy: EliminationPolicy,
) -> bool:
    return failure_counts.get(hypothesis.id, 0) >= policy.prediction_failure_threshold


def check_posterior_floor(
    hypothesis: Hypothesis,
    policy: EliminationPolicy,
) -> bool:
    return hypothesis.confidence < policy.posterior_floor


def eliminate(
    hypothesis_set: HypothesisSet,
    evidence_store: EvidenceStore,
    failure_counts: dict[str, int],
    policy: EliminationPolicy,
) -> HypothesisSet:
    """Move hypotheses meeting any elimination condition to the eliminated set.

    An empty active set after elimination is valid — it signals to coverage_health
    in P3 that no hypotheses survived the current evidence.
    """
    remaining: list[Hypothesis] = []

    for h in hypothesis_set.active:
        reason: EliminationReason | None = None
        if check_contradicting_evidence(h, evidence_store):
            reason = "CONTRADICTING_EVIDENCE"
        elif check_prediction_failure(h, failure_counts, policy):
            reason = "PREDICTION_FAILURE"
        elif check_posterior_floor(h, policy):
            reason = "POSTERIOR_BELOW_FLOOR"

        if reason is not None:
            record = EliminationRecord(
                hypothesis_id=h.id,
                reason=reason,
                eliminated_at=datetime.now(UTC),
            )
            hypothesis_set.eliminated.append((h, record))
        else:
            remaining.append(h)

    hypothesis_set.active = remaining

    if len(hypothesis_set.eliminated) > policy.k_retention:
        hypothesis_set.eliminated.sort(key=lambda pair: pair[1].eliminated_at)
        hypothesis_set.eliminated = hypothesis_set.eliminated[-policy.k_retention :]

    return hypothesis_set


def compute_diversity_score(hypothesis_set: HypothesisSet) -> float:
    """Compute normalised Shannon entropy over generation sources in the active set."""
    source_counts: dict[str, int] = {}
    for h in hypothesis_set.active:
        for src in h.generation_sources:
            source_counts[src] = source_counts.get(src, 0) + 1

    total = sum(source_counts.values())
    if total == 0 or len(source_counts) < 2:
        hypothesis_set.diversity_score = 0.0
        return 0.0

    probs = [count / total for count in source_counts.values()]
    entropy = -sum(p * math.log2(p) for p in probs if p > 0)
    max_entropy = math.log2(len(source_counts))
    score = max(0.0, min(1.0, entropy / max_entropy)) if max_entropy > 0 else 0.0
    hypothesis_set.diversity_score = score
    return score


def enforce_diversity(
    hypothesis_set: HypothesisSet,
    world_model: WorldModel,
    evidence_store: EvidenceStore,
    fml_stub: dict | None,
    experience_store: Any,
    policy: EliminationPolicy,
) -> HypothesisSet:
    """Trigger additional generation passes until diversity meets threshold or cap is hit."""
    compute_diversity_score(hypothesis_set)
    pass_count = 0
    while hypothesis_set.diversity_score < policy.diversity_threshold and pass_count < policy.max_diversity_passes:
        new_hypotheses = generate_hypotheses(world_model, evidence_store, fml_stub, experience_store)
        hypothesis_set.active.extend(new_hypotheses)
        compute_diversity_score(hypothesis_set)
        pass_count += 1
    return hypothesis_set
