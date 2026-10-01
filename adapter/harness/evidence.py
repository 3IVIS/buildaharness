"""
Evidence data model and store — P1.1.

Twin of packages/harness/src/state/evidence-store.ts (+ nodes/gather-evidence.ts). Evidence objects are immutable by
convention — never mutate in place. SYSTEM_ERROR evidence is always reliability=HIGH by architectural contract.

The store also carries the run's tool-reliability envelopes and tool-availability manifest (as the TS EvidenceStore
does), so it can be handed to any check that asks "is this tool available?" (`check_tool_availability` is an alias
of `is_tool_available`).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

EvidenceType = Literal["OBSERVATION", "INFERENCE", "SYSTEM_ERROR"]
ReliabilityClass = Literal["HIGH", "MEDIUM", "LOW"]

_RELIABILITY_ORDER: dict[str, int] = {"LOW": 0, "MEDIUM": 1, "HIGH": 2}
_RELIABILITY_FROM_ORDER: dict[int, str] = {0: "LOW", 1: "MEDIUM", 2: "HIGH"}


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


@dataclass
class Evidence:
    id: str
    obs: str
    reliability: ReliabilityClass
    source: str
    evidence_type: EvidenceType
    # ISO-8601 timestamp of when the evidence was gathered (TS Evidence.freshness).
    freshness: str = field(default_factory=_now_iso)

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
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Evidence:
        freshness = d.get("freshness")
        if not isinstance(freshness, str):
            recorded_at = d.get("recorded_at")
            freshness = recorded_at if isinstance(recorded_at, str) else _now_iso()
        return cls(
            id=d["id"],
            obs=d["obs"],
            reliability=d["reliability"],
            source=d["source"],
            evidence_type=d["evidence_type"],
            freshness=freshness,
        )


@dataclass
class ToolReliabilityEnvelope:
    """Per-tool caps on the reliability an observation / conclusion drawn from that tool may claim."""

    tool: str
    max_observation_reliability: ReliabilityClass = "HIGH"
    max_conclusion_reliability: ReliabilityClass = "HIGH"

    def to_dict(self) -> dict[str, Any]:
        return {
            "tool": self.tool,
            "max_observation_reliability": self.max_observation_reliability,
            "max_conclusion_reliability": self.max_conclusion_reliability,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> ToolReliabilityEnvelope:
        return cls(
            tool=d["tool"],
            max_observation_reliability=d.get("max_observation_reliability", "HIGH"),
            max_conclusion_reliability=d.get("max_conclusion_reliability", "HIGH"),
        )


@dataclass
class ToolAvailability:
    available: bool
    fallback_tool: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {"available": self.available, "fallback_tool": self.fallback_tool}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> ToolAvailability:
        return cls(available=bool(d["available"]), fallback_tool=d.get("fallback_tool"))


@dataclass
class EvidenceStore:
    observations: list[Evidence] = field(default_factory=list)
    tool_reliability_envelopes: dict[str, ToolReliabilityEnvelope] = field(default_factory=dict)
    tool_availability_manifest: dict[str, ToolAvailability] = field(default_factory=dict)

    # ── writes ──────────────────────────────────────────────────────────────
    def add_observation(self, evidence: Evidence) -> None:
        self.observations.append(evidence)

    def append(self, evidence: Evidence) -> None:
        """Alias of add_observation (the pre-TS-parity name)."""
        self.add_observation(evidence)

    def clear(self) -> None:
        self.observations.clear()

    # ── reads ───────────────────────────────────────────────────────────────
    @property
    def entries(self) -> list[Evidence]:
        """Alias of `observations` (the pre-TS-parity name)."""
        return self.observations

    @entries.setter
    def entries(self, value: list[Evidence]) -> None:
        self.observations = value

    def is_tool_available(self, tool_name: str) -> bool:
        """A tool that is not in the manifest is unavailable (TS isToolAvailable)."""
        entry = self.tool_availability_manifest.get(tool_name)
        return entry.available if entry is not None else False

    def check_tool_availability(self, tool_name: str) -> bool:
        """Alias of is_tool_available so the store can stand in for a tool manifest."""
        return self.is_tool_available(tool_name)

    def query(
        self,
        reliability: str | None = None,
        evidence_type: str | None = None,
    ) -> list[Evidence]:
        results = self.observations
        if reliability is not None:
            results = [e for e in results if e.reliability == reliability]
        if evidence_type is not None:
            results = [e for e in results if e.evidence_type == evidence_type]
        return results

    # ── serialisation ───────────────────────────────────────────────────────
    def to_dict(self) -> dict[str, Any]:
        return {
            "observations": [e.to_dict() for e in self.observations],
            "tool_reliability_envelopes": {k: v.to_dict() for k, v in self.tool_reliability_envelopes.items()},
            "tool_availability_manifest": {k: v.to_dict() for k, v in self.tool_availability_manifest.items()},
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> EvidenceStore:
        return cls(
            observations=[Evidence.from_dict(e) for e in d.get("observations", d.get("entries", []))],
            tool_reliability_envelopes={
                k: ToolReliabilityEnvelope.from_dict(v) for k, v in d.get("tool_reliability_envelopes", {}).items()
            },
            tool_availability_manifest={
                k: ToolAvailability.from_dict(v) for k, v in d.get("tool_availability_manifest", {}).items()
            },
        )


def gather_evidence(
    *,
    id: str,
    obs: str,
    source: str,
    evidence_type: EvidenceType,
    evidence_store: EvidenceStore,
    freshness: str | None = None,
    reliability: ReliabilityClass | None = None,
    on_warning: Callable[[str], None] | None = None,
) -> Evidence | None:
    """Record one piece of evidence if its source tool is available (TS gatherEvidence).

    An unavailable (or unregistered) source yields a warning and no evidence. SYSTEM_ERROR evidence is always HIGH;
    everything else defaults to MEDIUM.
    """
    if not evidence_store.is_tool_available(source):
        if on_warning is not None:
            on_warning(f'gatherEvidence: tool "{source}" unavailable; no evidence collected')
        return None

    resolved: ReliabilityClass = "HIGH" if evidence_type == "SYSTEM_ERROR" else (reliability or "MEDIUM")
    evidence = Evidence(
        id=id,
        obs=obs,
        reliability=resolved,
        source=source,
        evidence_type=evidence_type,
        freshness=freshness or _now_iso(),
    )
    evidence_store.add_observation(evidence)
    return evidence
