"""
Failure mode library — P6.3.

Twin of packages/harness/src/state/failure-diagnostics.ts. Read-only diagnostic pattern matcher: it contributes
a normalised confidence to Tier 4 of resolve_control_state() and seeds hypotheses as generation source 3.
MatchResult has no write path to block_mask or escalation_reason (INV-08).

A library is a list of `FailureModeEntry` rows (id, failure_class, curated symptom phrases, a description and an
optional strategy affinity) plus per-class prior probabilities. `match(symptoms)` compares the observed symptom
strings against each entry's curated phrases (case-insensitive, either string containing the other) and returns
the best-scoring entry, or None.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from .lexical_off import harness_lexical_active
from .recovery import StrategyType


@dataclass
class MatchResult:
    """Advisory diagnostic result — no write path to block_mask or escalation_reason."""

    failure_class: str
    confidence: float
    matched_pattern: str  # the matched FailureModeEntry.id
    strategy_affinity: StrategyType | None = None

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "failure_class": self.failure_class,
            "confidence": self.confidence,
            "matched_pattern": self.matched_pattern,
        }
        if self.strategy_affinity is not None:
            d["strategy_affinity"] = self.strategy_affinity
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> MatchResult:
        return cls(
            failure_class=d["failure_class"],
            confidence=d["confidence"],
            matched_pattern=d["matched_pattern"],
            strategy_affinity=d.get("strategy_affinity"),
        )


@dataclass
class FailureModeEntry:
    id: str
    failure_class: str
    symptoms: list[str]
    pattern_description: str
    strategy_affinity: StrategyType | None = None

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "id": self.id,
            "failure_class": self.failure_class,
            "symptoms": list(self.symptoms),
            "pattern_description": self.pattern_description,
        }
        if self.strategy_affinity is not None:
            d["strategy_affinity"] = self.strategy_affinity
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> FailureModeEntry:
        return cls(
            id=d["id"],
            failure_class=d["failure_class"],
            symptoms=list(d.get("symptoms", [])),
            pattern_description=d.get("pattern_description", ""),
            strategy_affinity=d.get("strategy_affinity"),
        )


DEFAULT_FAILURE_MODE_ENTRIES: list[FailureModeEntry] = [
    FailureModeEntry(
        id="circular-dependency",
        failure_class="CIRCULAR_DEPENDENCY",
        symptoms=["circular dependency", "depends on itself", "dependency cycle", "blocked on each other"],
        pattern_description="Two or more tasks/beliefs depend on each other in a cycle, so nothing can complete first.",
        strategy_affinity="BROADER_SEARCH",
    ),
    FailureModeEntry(
        id="tool-unavailable-cascade",
        failure_class="TOOL_UNAVAILABLE_CASCADE",
        symptoms=[
            "tool unavailable",
            "service unavailable",
            "connection refused",
            "not available",
            "unreachable",
            "rate limit exceeded",
            "too many requests",
            "request timed out",
        ],
        pattern_description=(
            "The same tool or service (or several) keeps failing to respond — unavailable, overloaded, rate-limited, "
            "timing out or unreachable — so repeating the identical call is unlikely to help and a different approach "
            "is needed."
        ),
        strategy_affinity="REIMPLEMENT",
    ),
    FailureModeEntry(
        id="scope-creep",
        failure_class="SCOPE_CREEP",
        symptoms=["scope expanded", "grew beyond", "beyond the original", "more than originally"],
        pattern_description=(
            "The task's write domain grew across iterations — each attempt takes on more than the last."
        ),
        strategy_affinity="MINIMAL_FIX",
    ),
    FailureModeEntry(
        id="stale-belief-reliance",
        failure_class="STALE_BELIEF_RELIANCE",
        symptoms=["stale belief", "outdated information", "no longer accurate", "no longer current"],
        pattern_description=(
            "A high-confidence belief the plan relies on is flagged stale — its source may no longer reflect reality."
        ),
        strategy_affinity="TRACE_EXEC",
    ),
]


class FailureModeLibrary:
    def __init__(
        self,
        entries: list[FailureModeEntry] | None = None,
        class_priors: dict[str, float] | None = None,
    ) -> None:
        self._entries: list[FailureModeEntry] = list(entries) if entries else []
        self.class_priors: dict[str, float] = dict(class_priors) if class_priors else {}

    @property
    def entries(self) -> tuple[FailureModeEntry, ...]:
        return tuple(self._entries)

    def get_entries(self) -> tuple[FailureModeEntry, ...]:
        return self.entries

    def match(self, symptoms: list[str]) -> MatchResult | None:
        """Best-matching entry for the observed symptom strings, or None (advisory, read-only)."""
        if not harness_lexical_active("failure-exact-match"):
            return None  # HARNESS_LEXICAL off: only a semantic matcher can classify
        best: MatchResult | None = None
        best_score = -1.0
        for entry in self._entries:
            overlap = sum(
                1
                for curated in entry.symptoms
                if curated and any(s.lower() in curated.lower() or curated.lower() in s.lower() for s in symptoms)
            )
            if overlap > 0:
                confidence = overlap / max(len(entry.symptoms), len(symptoms))
                if confidence > best_score:
                    best_score = confidence
                    best = MatchResult(
                        failure_class=entry.failure_class,
                        confidence=confidence,
                        matched_pattern=entry.id,
                        strategy_affinity=entry.strategy_affinity,
                    )
        return best

    def to_dict(self) -> dict[str, Any]:
        return {"entries": [e.to_dict() for e in self._entries], "class_priors": dict(self.class_priors)}


def build_default_library() -> FailureModeLibrary:
    """The library `initialize_harness` uses: the four seed entries, no class priors."""
    return FailureModeLibrary(list(DEFAULT_FAILURE_MODE_ENTRIES))


def resolve_semantic_match_strategy(
    semantic_match: MatchResult | dict[str, Any],
    entries: list[FailureModeEntry] | tuple[FailureModeEntry, ...],
) -> StrategyType | None:
    """Strategy affinity of the library entry a semantic matcher named (TS resolveSemanticMatchStrategy)."""
    pattern_id = (
        semantic_match["matched_pattern"] if isinstance(semantic_match, dict) else semantic_match.matched_pattern
    )
    return next((e.strategy_affinity for e in entries if e.id == pattern_id), None)


@dataclass
class FailureRecord:
    """One recorded failure (TS FailureRecord)."""

    failure_class: str
    description: str = ""
    id: str = field(default_factory=lambda: f"fail-{uuid.uuid4().hex[:6]}")
    timestamp: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    context: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "timestamp": self.timestamp,
            "failure_class": self.failure_class,
            "description": self.description,
            "context": dict(self.context),
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> FailureRecord:
        record = cls(
            failure_class=d.get("failure_class", "unknown"),
            description=d.get("description", ""),
            context=dict(d.get("context", {})),
        )
        if "id" in d:
            record.id = d["id"]
        if "timestamp" in d:
            record.timestamp = d["timestamp"]
        return record


@dataclass
class FailureDiagnostics:
    """Typed failure state of a run.

    `matched_pattern` is also where an external semantic failure-match check's result belongs (TS
    semanticFailureMatcher assigns to the same field; it is only consulted when the lexical match found nothing).
    """

    failure_history: list[FailureRecord] = field(default_factory=list)
    matched_pattern: MatchResult | None = None
    failure_mode_library: FailureModeLibrary = field(default_factory=FailureModeLibrary)

    def record_failure(self, record: FailureRecord) -> None:
        self.failure_history.append(record)

    def to_dict(self) -> dict[str, Any]:
        return {
            "matched_pattern": self.matched_pattern.to_dict() if self.matched_pattern is not None else None,
            "failure_history": [r.to_dict() for r in self.failure_history],
            "failure_mode_library_data": self.failure_mode_library.to_dict(),
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> FailureDiagnostics:
        mp = d.get("matched_pattern")
        lib_data = d.get("failure_mode_library_data")
        library = (
            FailureModeLibrary(
                [FailureModeEntry.from_dict(e) for e in lib_data.get("entries", [])],
                lib_data.get("class_priors", {}),
            )
            if lib_data is not None
            else FailureModeLibrary()
        )
        return cls(
            failure_history=[FailureRecord.from_dict(r) for r in d.get("failure_history", [])],
            matched_pattern=MatchResult.from_dict(mp) if mp else None,
            failure_mode_library=library,
        )
