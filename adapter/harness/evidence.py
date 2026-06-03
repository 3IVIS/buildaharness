"""
Evidence data model — P1.1.

Evidence objects are immutable by convention — never mutate in place.
SYSTEM_ERROR evidence is always reliability=HIGH by architectural contract.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

EvidenceType = Literal["OBSERVATION", "INFERENCE", "SYSTEM_ERROR"]
ReliabilityClass = Literal["HIGH", "MEDIUM", "LOW"]

_RELIABILITY_ORDER: dict[str, int] = {"LOW": 0, "MEDIUM": 1, "HIGH": 2}
_RELIABILITY_FROM_ORDER: dict[int, str] = {0: "LOW", 1: "MEDIUM", 2: "HIGH"}


@dataclass
class Evidence:
    id: str
    obs: str
    reliability: ReliabilityClass
    source: str
    evidence_type: EvidenceType
    freshness: float
    recorded_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    def __post_init__(self) -> None:
        if self.evidence_type == "SYSTEM_ERROR" and self.reliability != "HIGH":
            raise ValueError("SYSTEM_ERROR evidence must have reliability=HIGH")

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "obs": self.obs,
            "reliability": self.reliability,
            "source": self.source,
            "evidence_type": self.evidence_type,
            "freshness": self.freshness,
            "recorded_at": self.recorded_at.isoformat(),
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Evidence:
        return cls(
            id=d["id"],
            obs=d["obs"],
            reliability=d["reliability"],
            source=d["source"],
            evidence_type=d["evidence_type"],
            freshness=d["freshness"],
            recorded_at=datetime.fromisoformat(d["recorded_at"]) if "recorded_at" in d else datetime.now(UTC),
        )


@dataclass
class EvidenceStore:
    entries: list[Evidence] = field(default_factory=list)

    def append(self, evidence: Evidence) -> None:
        self.entries.append(evidence)

    def query(
        self,
        reliability: str | None = None,
        evidence_type: str | None = None,
    ) -> list[Evidence]:
        results = self.entries
        if reliability is not None:
            results = [e for e in results if e.reliability == reliability]
        if evidence_type is not None:
            results = [e for e in results if e.evidence_type == evidence_type]
        return results

    def clear(self) -> None:
        self.entries.clear()

    def to_dict(self) -> dict[str, Any]:
        return {"entries": [e.to_dict() for e in self.entries]}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> EvidenceStore:
        store = cls()
        for entry in d.get("entries", []):
            store.entries.append(Evidence.from_dict(entry))
        return store
