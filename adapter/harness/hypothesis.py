"""
Hypothesis set and generation — P1.6 and P1.7.

Twin of packages/harness/src/state/hypothesis-set.ts and nodes/generate-update-hypotheses.ts.

Each pass seeds one hypothesis per generation source (symptom inference, counterfactual, failure-mode library,
analogy). Passes repeat until the source-diversity score (normalised Shannon entropy over the sources of the active
hypotheses) reaches `DIVERSITY_THRESHOLD` or `MAX_PASSES` is hit. Low-confidence hypotheses, and those a world-model
contradiction names, are then eliminated; an oversized active set is pruned to the `KEEP_BELIEFS` most confident.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

from .diagnostics import normalise
from .evidence import EvidenceStore
from .failure_modes import FailureDiagnostics
from .memory import MemoryState, PrunedRegion
from .world_model import WorldModel

MAX_BELIEFS = 10
KEEP_BELIEFS = 5
DIVERSITY_THRESHOLD = 0.7
MAX_PASSES = 10

GenerationSource = Literal["symptom_inference", "counterfactual", "failure_mode_library", "analogy"]
GENERATION_SOURCES: tuple[GenerationSource, ...] = (
    "symptom_inference",
    "counterfactual",
    "failure_mode_library",
    "analogy",
)


@dataclass
class Hypothesis:
    id: str
    explanation: str
    confidence: float
    predicted_observations: list[str] = field(default_factory=list)
    discriminating_evidence: list[str] = field(default_factory=list)
    generation_sources: list[str] = field(default_factory=list)
    diversity_score: float = 0.0
    # Semantic hypotheses only: the check or observation that would tell this explanation apart from its rivals.
    separating_check: str | None = None

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "id": self.id,
            "explanation": self.explanation,
            "confidence": self.confidence,
            "predicted_observations": list(self.predicted_observations),
            "discriminating_evidence": list(self.discriminating_evidence),
            "generation_sources": list(self.generation_sources),
            "diversity_score": self.diversity_score,
        }
        if self.separating_check:
            d["separating_check"] = self.separating_check
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Hypothesis:
        return cls(
            id=d["id"],
            explanation=d["explanation"],
            confidence=d["confidence"],
            predicted_observations=list(d.get("predicted_observations", [])),
            discriminating_evidence=list(d.get("discriminating_evidence", [])),
            generation_sources=list(d.get("generation_sources", [])),
            diversity_score=d.get("diversity_score", 0.0),
            separating_check=d.get("separating_check"),
        )


@dataclass
class EliminationPolicy:
    """Twin of TS EliminationPolicy: `floor` is the confidence below which a hypothesis is dropped and
    `retention_k` bounds the audit trail of eliminated hypotheses."""

    conditions: list[str] = field(default_factory=lambda: ["contradicting_evidence", "prediction_failure_count"])
    retention_k: int = 10
    floor: float = 0.05

    def to_dict(self) -> dict[str, Any]:
        return {"conditions": list(self.conditions), "retention_k": self.retention_k, "floor": self.floor}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> EliminationPolicy:
        return cls(
            conditions=list(d.get("conditions", ["contradicting_evidence", "prediction_failure_count"])),
            retention_k=d.get("retention_k", 10),
            floor=d.get("floor", 0.05),
        )


@dataclass
class HypothesisSet:
    active: list[Hypothesis] = field(default_factory=list)
    eliminated: list[Hypothesis] = field(default_factory=list)
    elimination_policy: EliminationPolicy = field(default_factory=EliminationPolicy)

    def eliminate(self, hypothesis: Hypothesis) -> None:
        """Move a hypothesis from active to eliminated, keeping only the last `retention_k` eliminated."""
        self.active = [h for h in self.active if h.id != hypothesis.id]
        self.eliminated.append(hypothesis)
        excess = len(self.eliminated) - self.elimination_policy.retention_k
        if excess > 0:
            del self.eliminated[:excess]

    def to_dict(self) -> dict[str, Any]:
        return {
            "active": [h.to_dict() for h in self.active],
            "eliminated": [h.to_dict() for h in self.eliminated],
            "elimination_policy": self.elimination_policy.to_dict(),
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> HypothesisSet:
        return cls(
            active=[Hypothesis.from_dict(h) for h in d.get("active", [])],
            eliminated=[
                Hypothesis.from_dict(h["hypothesis"] if "hypothesis" in h else h) for h in d.get("eliminated", [])
            ],
            elimination_policy=EliminationPolicy.from_dict(d.get("elimination_policy", {})),
        )


# ── diversity ─────────────────────────────────────────────────────────────────


def compute_diversity_score(hypothesis_set: HypothesisSet) -> float:
    """Normalised Shannon entropy of the generation sources across the active hypotheses (0 when none)."""
    if not hypothesis_set.active:
        return 0.0
    sources: list[str] = []
    for h in hypothesis_set.active:
        for s in h.generation_sources:
            if s not in sources:
                sources.append(s)
    counts = [sum(1 for h in hypothesis_set.active if s in h.generation_sources) for s in sources]
    return normalise(counts, "entropy")


def compute_source_entropy(hypothesis_set: HypothesisSet) -> float:
    return compute_diversity_score(hypothesis_set)


# ── generation ────────────────────────────────────────────────────────────────


def _make_seed(id: str, source: GenerationSource, explanation: str, confidence: float = 0.5) -> Hypothesis:
    return Hypothesis(
        id=id,
        explanation=explanation,
        confidence=confidence,
        predicted_observations=[],
        discriminating_evidence=[],
        generation_sources=[source],
        diversity_score=0.0,
    )


def _generate_from_source(
    source: GenerationSource,
    world_model: WorldModel,
    evidence_store: EvidenceStore,
    hypothesis_set: HypothesisSet,
    failure_diagnostics: FailureDiagnostics,
    pass_index: int,
) -> list[Hypothesis]:
    suffix = f"_p{pass_index}" if pass_index > 0 else ""

    if source == "symptom_inference":
        observations = evidence_store.observations
        if observations:
            return [
                _make_seed(f"symp_{o.id}{suffix}", source, f"Symptom inference from: {o.obs}", 0.4 + i * 0.05)
                for i, o in enumerate(observations[:1])
            ]
        return [_make_seed(f"symp_default{suffix}", source, "No symptoms observed — hypothesis: system nominal", 0.3)]

    if source == "counterfactual":
        beliefs = world_model.beliefs
        if beliefs:
            return [
                _make_seed(
                    f"counter_{beliefs[0].id}{suffix}",
                    source,
                    f'Counterfactual: if "{beliefs[0].statement}" were false, goal would be impacted',
                    0.35,
                )
            ]
        return [
            _make_seed(f"counter_default{suffix}", source, "Counterfactual: prior state differs from expected", 0.3)
        ]

    if source == "failure_mode_library":
        symptoms = [o.obs for o in evidence_store.observations]
        match = failure_diagnostics.failure_mode_library.match(symptoms)
        if match is not None:
            return [
                _make_seed(
                    f"fml_{match.matched_pattern}{suffix}",
                    source,
                    f"Failure mode match: {match.failure_class} (confidence {match.confidence:.2f})",
                    match.confidence,
                )
            ]
        return [_make_seed(f"fml_unknown{suffix}", source, "Failure mode: unknown pattern — exploratory", 0.2)]

    # analogy
    if hypothesis_set.eliminated:
        template = hypothesis_set.eliminated[0]
        return [
            _make_seed(
                f"analogy_{template.id}{suffix}",
                source,
                f"Analogy from eliminated hypothesis: {template.explanation}",
                0.25,
            )
        ]
    return [_make_seed(f"analogy_default{suffix}", source, "Analogy: no prior eliminations — structural guess", 0.2)]


def _apply_elimination_policy(hypothesis_set: HypothesisSet, world_model: WorldModel) -> None:
    to_eliminate = [
        h
        for h in hypothesis_set.active
        if h.confidence < hypothesis_set.elimination_policy.floor
        # a contradiction whose description references this hypothesis id contradicts it
        or any(h.id in c.description for c in world_model.contradictions)
    ]
    for h in to_eliminate:
        hypothesis_set.eliminate(h)


def generate_update_hypotheses(
    world_model: WorldModel,
    evidence_store: EvidenceStore,
    hypothesis_set: HypothesisSet,
    failure_diagnostics: FailureDiagnostics,
    memory_state: MemoryState,
) -> None:
    """Generate / refresh the active hypotheses (TS generateUpdateHypotheses)."""
    pass_index = 0
    diversity = compute_diversity_score(hypothesis_set)

    while True:
        existing_ids = {h.id for h in hypothesis_set.active}
        for source in GENERATION_SOURCES:
            for h in _generate_from_source(
                source, world_model, evidence_store, hypothesis_set, failure_diagnostics, pass_index
            ):
                if h.id not in existing_ids:
                    hypothesis_set.active.append(h)
                    existing_ids.add(h.id)
        diversity = compute_diversity_score(hypothesis_set)
        pass_index += 1
        if not (diversity < DIVERSITY_THRESHOLD and pass_index < MAX_PASSES):
            break

    for h in hypothesis_set.active:
        h.diversity_score = diversity

    _apply_elimination_policy(hypothesis_set, world_model)

    if len(hypothesis_set.active) > MAX_BELIEFS:
        hypothesis_set.active.sort(key=lambda h: h.confidence, reverse=True)
        pruned = hypothesis_set.active[KEEP_BELIEFS:]
        del hypothesis_set.active[KEEP_BELIEFS:]
        now = datetime.now(UTC).isoformat()
        for h in pruned:
            memory_state.compression_risk.pruned_regions.append(
                PrunedRegion(id=f"hypothesis_{h.id}", description=h.explanation, token_count=0, pruned_at=now)
            )
