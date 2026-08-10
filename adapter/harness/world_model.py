"""
World model data structures — P0.2.

Enforces the core invariant: observations and beliefs are separate typed
structures. A belief cannot be created without an explicit derived_from[]
chain — auto-promotion from observation is a structural error.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal


@dataclass
class Observation:
    id: str
    content: str
    source: str
    recorded_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "content": self.content,
            "source": self.source,
            "recorded_at": self.recorded_at.isoformat(),
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Observation:
        return cls(
            id=d["id"],
            content=d["content"],
            source=d["source"],
            recorded_at=datetime.fromisoformat(d["recorded_at"]) if "recorded_at" in d else datetime.now(UTC),
        )


@dataclass
class Belief:
    id: str
    statement: str
    confidence: float
    derived_from: list[str]
    supporting_evidence: list[str] = field(default_factory=list)
    reliability: str = ""
    recorded_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    # Belief ids this belief has been found to contradict — stamped by
    # WorldModel.add_contradiction() below, not set directly. Alongside derived_from[]
    # this makes the provenance graph the critique asked for ("Belief B17, derived from
    # E42/E51, contradicts B13") queryable from the belief itself, not only recoverable
    # by scanning world_model.contradictions[].involved_belief_ids for this id.
    contradicts: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "statement": self.statement,
            "confidence": self.confidence,
            "derived_from": self.derived_from,
            "supporting_evidence": self.supporting_evidence,
            "recorded_at": self.recorded_at.isoformat(),
            "contradicts": self.contradicts,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Belief:
        return cls(
            id=d["id"],
            statement=d["statement"],
            confidence=d["confidence"],
            derived_from=d["derived_from"],
            supporting_evidence=d.get("supporting_evidence", []),
            recorded_at=datetime.fromisoformat(d["recorded_at"]) if "recorded_at" in d else datetime.now(UTC),
            contradicts=d.get("contradicts", []),
        )


ContradictionType = Literal["pairwise", "set-level", "temporal", "abstraction"]
ContradictionSeverity = Literal["LOW", "MEDIUM", "HIGH", "SYSTEM_BREAKING"]
ContradictionScope = Literal["local", "task", "global"]


@dataclass
class Contradiction:
    id: str
    type: ContradictionType
    severity: ContradictionSeverity
    scope: ContradictionScope
    involved_belief_ids: list[str] = field(default_factory=list)
    # Matches TS's Contradiction.description (packages/harness/src/state/world-model.ts) — was
    # missing here entirely; defaulted to "" (not None) so every existing to_dict()/from_dict()
    # round-trip and internal detector constructor call stays byte-compatible without needing to
    # touch each one. Populated for record_external_contradiction() (Phase 2 of
    # plans/lexical_functions_hardening_plan.html), which needs somewhere to put the semantic
    # check's own finding text — the four internal lexical detectors don't set this yet, a known,
    # separate gap from that same file's TS/Python description-text drift, not fixed here.
    description: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "type": self.type,
            "severity": self.severity,
            "scope": self.scope,
            "involved_belief_ids": self.involved_belief_ids,
            "description": self.description,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Contradiction:
        return cls(
            id=d["id"],
            type=d["type"],
            severity=d["severity"],
            scope=d["scope"],
            involved_belief_ids=d.get("involved_belief_ids", []),
            description=d.get("description", ""),
        )


@dataclass
class WorldModel:
    generation_id: int = 0
    observations: list[Observation] = field(default_factory=list)
    beliefs: list[Belief] = field(default_factory=list)
    assumptions: list[str] = field(default_factory=list)
    contradictions: list[Contradiction] = field(default_factory=list)
    environment_change_log: list[dict[str, Any]] = field(default_factory=list)
    completeness_flags: dict[str, bool] = field(default_factory=dict)
    # Belief IDs flagged as stale after a constraint/criteria change (P7)
    stale_flags: dict[str, bool] = field(default_factory=dict)

    def add_observation(self, obs: Observation) -> None:
        self.observations.append(obs)

    def add_belief(self, belief: Belief) -> None:
        if not belief.derived_from:
            raise ValueError(
                f"derived_from must be non-empty (belief id='{belief.id}'). "
                "A belief requires at least one source in derived_from[] — "
                "auto-promotion from an observation without an explicit derivation chain is disallowed."
            )
        self.beliefs.append(belief)

    def add_contradiction(self, contradiction: Contradiction) -> None:
        # SYSTEM_BREAKING contradictions are stored here and picked up by the
        # next resolve_control_state() Tier 1 pass — they never cause an inline
        # halt or raise an exception at this layer.
        self.contradictions.append(contradiction)
        # Stamp contradicts[] onto every involved belief so the relationship is
        # queryable from the belief itself (see Belief.contradicts' own docstring).
        # Pairwise between all involved beliefs, not just "each points at the
        # contradiction" — a 3+-way set-level contradiction means every belief in it
        # contradicts every other one, not just the contradiction record.
        beliefs_by_id = {b.id: b for b in self.beliefs}
        for belief_id in contradiction.involved_belief_ids:
            belief = beliefs_by_id.get(belief_id)
            if belief is None:
                continue
            for other_id in contradiction.involved_belief_ids:
                if other_id != belief_id and other_id not in belief.contradicts:
                    belief.contradicts.append(other_id)

    def to_dict(self) -> dict[str, Any]:
        return {
            "generation_id": self.generation_id,
            "observations": [o.to_dict() for o in self.observations],
            "beliefs": [b.to_dict() for b in self.beliefs],
            "assumptions": list(self.assumptions),
            "contradictions": [c.to_dict() for c in self.contradictions],
            "environment_change_log": list(self.environment_change_log),
            "completeness_flags": dict(self.completeness_flags),
            "stale_flags": dict(self.stale_flags),
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> WorldModel:
        wm = cls(
            generation_id=d.get("generation_id", 0),
            assumptions=d.get("assumptions", []),
            environment_change_log=d.get("environment_change_log", []),
            completeness_flags=d.get("completeness_flags", {}),
            stale_flags=d.get("stale_flags", {}),
        )
        for o in d.get("observations", []):
            wm.observations.append(Observation.from_dict(o))
        for b in d.get("beliefs", []):
            # Bypass the validation guard when deserialising — the data was
            # already validated when it was first persisted.
            wm.beliefs.append(Belief.from_dict(b))
        for c in d.get("contradictions", []):
            wm.contradictions.append(Contradiction.from_dict(c))
        return wm
