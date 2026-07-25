"""
Failure mode library — P6.3.

Read-only diagnostic pattern matcher. Contributes normalised_confidence to Tier 4
of resolve_control_state() and seeds hypotheses as generation source 3.
MatchResult is designed with no write path to block_mask or escalation_reason (INV-08).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from .recovery import StrategyType

if TYPE_CHECKING:
    pass


@dataclass
class FailurePattern:
    name: str
    description: str
    required_conditions: list[str]
    excluded_conditions: list[str]
    strategy_affinity: StrategyType | None
    hypothesis_template: str


@dataclass
class MatchResult:
    """Advisory diagnostic result — no write path to block_mask or escalation_reason."""

    matched: bool
    pattern_name: str
    raw_confidence: float
    normalised_confidence: float
    strategy_affinity: StrategyType | None = None

    @property
    def confidence(self) -> float:
        """Alias for Tier 4 compatibility — returns normalised_confidence."""
        return self.normalised_confidence


def normalise_confidence(raw: float) -> float:
    return max(0.0, min(1.0, raw))


def _no_match() -> MatchResult:
    return MatchResult(
        matched=False,
        pattern_name="",
        raw_confidence=0.0,
        normalised_confidence=0.0,
        strategy_affinity=None,
    )


class FailureModeLibrary:
    def __init__(self, patterns: list[FailurePattern]) -> None:
        self._patterns: tuple[FailurePattern, ...] = tuple(patterns)

    @property
    def patterns(self) -> tuple[FailurePattern, ...]:
        return self._patterns

    def match(
        self,
        world_model: Any,
        hypothesis_set: Any,
        task_graph: Any,
    ) -> MatchResult:
        """Return the best-matching pattern result (advisory, read-only)."""
        beliefs: list[Any] = getattr(world_model, "beliefs", []) if world_model else []
        belief_statements = [getattr(b, "statement", "") for b in beliefs]

        hypotheses: list[Any] = getattr(hypothesis_set, "active", []) if hypothesis_set else []
        hyp_texts = [getattr(h, "explanation", "") for h in hypotheses]

        tasks: list[Any] = getattr(task_graph, "tasks", []) if task_graph else []
        task_texts = [getattr(t, "description", "") for t in tasks]

        context_text = " ".join(belief_statements + hyp_texts + task_texts).lower()

        best_pattern: FailurePattern | None = None
        best_raw: float = 0.0

        for pattern in self._patterns:
            excluded_hit = any(cond.lower() in context_text for cond in pattern.excluded_conditions)
            if excluded_hit:
                continue

            total = len(pattern.required_conditions) if pattern.required_conditions else 1
            matched_count = sum(1 for cond in pattern.required_conditions if cond.lower() in context_text)
            raw = matched_count / total

            if raw > best_raw:
                best_raw = raw
                best_pattern = pattern

        if best_pattern is None or best_raw == 0.0:
            return _no_match()

        norm = normalise_confidence(best_raw)
        return MatchResult(
            matched=True,
            pattern_name=best_pattern.name,
            raw_confidence=best_raw,
            normalised_confidence=norm,
            strategy_affinity=best_pattern.strategy_affinity,
        )


def build_default_library() -> FailureModeLibrary:
    """Build the default failure mode library with 4 seed patterns."""
    patterns = [
        FailurePattern(
            name="CIRCULAR_DEPENDENCY",
            description="Belief set contains mutually contradicting dependency cycle",
            required_conditions=["depends on", "circular", "cycle"],
            excluded_conditions=[],
            strategy_affinity="BROADER_SEARCH",
            hypothesis_template="A circular dependency exists in the belief graph preventing progress",
        ),
        FailurePattern(
            name="TOOL_UNAVAILABLE_CASCADE",
            description="Multiple SYSTEM_ERROR evidences from different tools",
            required_conditions=["system_error", "unavailable", "tool"],
            excluded_conditions=[],
            strategy_affinity="REIMPLEMENT",
            hypothesis_template="A cascade of tool unavailability errors is blocking execution",
        ),
        FailurePattern(
            name="SCOPE_CREEP",
            description="Task write domains grew across iterations",
            required_conditions=["write_domains", "scope", "expanded"],
            excluded_conditions=[],
            strategy_affinity="MINIMAL_FIX",
            hypothesis_template="The task scope has expanded beyond the original write domains",
        ),
        FailurePattern(
            name="STALE_BELIEF_RELIANCE",
            description="High-confidence beliefs whose sources are in stale_flags",
            required_conditions=["stale", "belief", "outdated"],
            excluded_conditions=[],
            strategy_affinity="TRACE_EXEC",
            hypothesis_template="The harness is relying on stale beliefs that no longer reflect the environment",
        ),
    ]
    return FailureModeLibrary(patterns)


# ── FailureDiagnostics typed dataclass ────────────────────────────────────────


@dataclass
class FailureEntry:
    failure_class: str
    step: int = 0
    description: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "failure_class": self.failure_class,
            "step": self.step,
            "description": self.description,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> FailureEntry:
        return cls(
            failure_class=d.get("failure_class", "unknown"),
            step=d.get("step", 0),
            description=d.get("description", ""),
        )


@dataclass
class FailureDiagnostics:
    """Typed replacement for the failure_diagnostics raw dict in HarnessRunState.

    matched_pattern is also where an external semantic failure-match check's result belongs —
    matches TS's semanticFailureMatcher hook (packages/harness/src/harness-runtime.ts), which is
    only ever consulted when the exact/lexical match above already found nothing
    (matched_pattern is still None) and assigns its result to this same field directly, no
    separate "record" function needed (unlike record_external_contradiction, which has to check
    for duplicates against a growing list — matched_pattern is a single slot, so last-write-wins
    is already correct). See record_external_contradiction's doc comment (contradiction.py) for
    why the integration point for this lives in whichever outer, already-async driver repeatedly
    calls run_one_iteration() (e.g. adapter/planner_api.py's `_run_planner`, or the per-adapter
    run functions in adapter/run_api.py) rather than inside harness-core's own synchronous loop.

    failure_mode_library mirrors TS's `readonly failure_mode_library: FailureModeLibrary` field
    (packages/harness/src/state/failure-diagnostics.ts) — previously absent here, which meant
    nothing ever populated matched_pattern from a real lexical match (see loop.py's per-iteration
    wiring, Phase 5 of plans/lexical_functions_hardening_plan.html). Defaults to the 4 seed
    patterns from build_default_library() rather than an empty library, since an empty one would
    make the lexical match (and everything layered on top of it) permanently inert by default —
    every existing caller that never set this field gets real patterns to match against instead of
    silent no-ops, which is a behavior change only for callers that start using the new
    per-iteration wiring; nothing sets it today, so no existing test observes a difference.
    """

    failure_history: list[FailureEntry] = field(default_factory=list)
    matched_pattern: MatchResult | None = None
    failure_mode_library: FailureModeLibrary = field(default_factory=lambda: build_default_library())

    def to_dict(self) -> dict[str, Any]:
        return {
            "failure_history": [e.to_dict() for e in self.failure_history],
            "matched_pattern": {
                "matched": self.matched_pattern.matched,
                "pattern_name": self.matched_pattern.pattern_name,
                "raw_confidence": self.matched_pattern.raw_confidence,
                "normalised_confidence": self.matched_pattern.normalised_confidence,
                "strategy_affinity": self.matched_pattern.strategy_affinity,
            }
            if self.matched_pattern is not None
            else None,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> FailureDiagnostics:
        mp_data = d.get("matched_pattern")
        matched_pattern: MatchResult | None = None
        if mp_data:
            matched_pattern = MatchResult(
                matched=mp_data.get("matched", False),
                pattern_name=mp_data.get("pattern_name", ""),
                raw_confidence=mp_data.get("raw_confidence", 0.0),
                normalised_confidence=mp_data.get("normalised_confidence", 0.0),
                strategy_affinity=mp_data.get("strategy_affinity"),
            )
        return cls(
            failure_history=[FailureEntry.from_dict(e) for e in d.get("failure_history", [])],
            matched_pattern=matched_pattern,
        )
