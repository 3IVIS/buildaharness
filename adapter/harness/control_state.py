"""
Control state, deadlock detection, and resolve_control_state() — P3.3 and P3.4.

ControlState is the sole control input for action selection (INV-06).
resolve_control_state() applies five tiers in strict order.
detect_deadlock() uses directed cycle detection on the recovery-action graph.
dep_class_gap_annotation is attached to notes[] only — never enters arithmetic (INV-07).

Phase 1a of plans/harness_and_assistant_architecture_remediation_plan.html split the old
single `risk_state: NORMAL/CAUTIOUS/BLOCKED` field into five distinct concepts, per the
critique's "what does CAUTIOUS actually mean — a probability? a permission? a mode?"
objection:
  - `permission`         — PermissionDecision, the authoritative ALLOW/DENY action gate.
  - `execution_mode`     — ExecutionMode, a mode label independent of permission (an ALLOWed
                            action can still be in CAUTIOUS mode, signalling the caller
                            should behave more conservatively without being blocked).
  - `escalation`          — EscalationDecision, a structured category distinct from the
                            free-text `escalation_reason` detail string.
  - `risk_estimate`      — a continuous [0,1] score computed from the *operational* sub-
                            dimensions (verification/progress/failure/oscillation health).
  - `confidence_estimate` — a continuous [0,1] score computed from the *epistemic* sub-
                            dimensions (belief/coverage health) — a distinct signal from
                            risk_estimate, not the same composite number surfaced twice.
`RiskState` and `risk_summary()` remain as a derived, three-way legacy view used only by
strategy_state.risk_state_history's oscillation-detection proxy (progress.py), which
predates this split and is out of this phase's scope to rework.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from ._core_generated import (
    CAUTION_THRESHOLD,
    CRITICAL_THRESHOLD,
    DEP_CLASS_GAP_NOTE_PREFIX,
    RECOVERY_ACTION_DEPENDENCIES,
)
from ._core_generated import CONFIDENCE_DIMENSIONS as _CONFIDENCE_DIMENSIONS
from ._core_generated import DIMENSION_RECOVERY as _DIMENSION_RECOVERY
from ._core_generated import RISK_DIMENSIONS as _RISK_DIMENSIONS
from .diagnostics import (
    Diagnostics,
    DimensionType,
    assert_normalised,
    normalise,
)

# CRITICAL_THRESHOLD, CAUTION_THRESHOLD, RECOVERY_ACTION_DEPENDENCIES,
# _DIMENSION_RECOVERY, _CONFIDENCE_DIMENSIONS, _RISK_DIMENSIONS and
# DEP_CLASS_GAP_NOTE_PREFIX are generated from spec/harness-core.json into
# ._core_generated (Phase C1 — docs/adr/004-shared-semantic-core.md), the single
# source of truth shared with packages/harness/src/_core-generated.ts. The
# resolver ALGORITHM below stays hand-mirrored with resolve-control-state.ts,
# guarded by scripts/harness-conformance/compare.mjs.
#
# _CONFIDENCE_DIMENSIONS / _RISK_DIMENSIONS are disjoint sub-dimension pools
# risk_estimate/confidence_estimate are computed from — see
# _compute_risk_and_confidence_estimates(). Every name in
# _extract_sub_dimensions()'s ten appears in exactly one pool.

RiskState = Literal["NORMAL", "CAUTIOUS", "BLOCKED"]
PermissionDecision = Literal["ALLOW", "DENY"]
ExecutionMode = Literal["NORMAL", "CAUTIOUS", "RECOVERY"]
EscalationDecision = Literal["NONE", "HUMAN_REQUIRED", "SYSTEM_BREAKING"]


@dataclass
class BlockEntry:
    dimension: str
    value: float
    recovery_action_class: str


@dataclass
class ControlState:
    generation_id: int = 0
    permission: PermissionDecision = "ALLOW"
    execution_mode: ExecutionMode = "NORMAL"
    escalation: EscalationDecision = "NONE"
    risk_estimate: float = 0.0
    confidence_estimate: float = 1.0
    escalation_reason: str | None = None
    block_mask: list[BlockEntry] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "generation_id": self.generation_id,
            "permission": self.permission,
            "execution_mode": self.execution_mode,
            "escalation": self.escalation,
            "risk_estimate": self.risk_estimate,
            "confidence_estimate": self.confidence_estimate,
            "escalation_reason": self.escalation_reason,
            "block_mask": [
                {
                    "dimension": b.dimension,
                    "value": b.value,
                    "recovery_action_class": b.recovery_action_class,
                }
                for b in self.block_mask
            ],
            "notes": list(self.notes),
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> ControlState:
        return cls(
            generation_id=d.get("generation_id", 0),
            permission=d.get("permission", "ALLOW"),
            execution_mode=d.get("execution_mode", "NORMAL"),
            escalation=d.get("escalation", "NONE"),
            risk_estimate=d.get("risk_estimate", 0.0),
            confidence_estimate=d.get("confidence_estimate", 1.0),
            escalation_reason=d.get("escalation_reason"),
            block_mask=[
                BlockEntry(
                    dimension=b["dimension"],
                    value=b["value"],
                    recovery_action_class=b["recovery_action_class"],
                )
                for b in d.get("block_mask", [])
            ],
            notes=d.get("notes", []),
        )


def risk_summary(cs: ControlState) -> RiskState:
    """Derives the old three-way NORMAL/CAUTIOUS/BLOCKED reading from the split fields —
    used only where a caller still genuinely needs that shape (today: just
    strategy_state.risk_state_history's oscillation-detection proxy in progress.py)."""
    if cs.permission == "DENY":
        return "BLOCKED"
    if cs.execution_mode == "CAUTIOUS":
        return "CAUTIOUS"
    return "NORMAL"


# ── Deadlock detection (P3.4) ─────────────────────────────────────────────────


def build_recovery_action_graph(block_mask: list[BlockEntry]) -> dict[str, set[str]]:
    """Build directed graph: dimension → set of blocked dimensions its recovery requires."""
    blocked_dims = {entry.dimension for entry in block_mask}
    graph: dict[str, set[str]] = {entry.dimension: set() for entry in block_mask}
    for entry in block_mask:
        required = RECOVERY_ACTION_DEPENDENCIES.get(entry.recovery_action_class, set())
        for req_dim in required:
            if req_dim in blocked_dims:
                graph[entry.dimension].add(req_dim)
    return graph


def has_cycle(graph: dict[str, set[str]]) -> bool:
    """Iterative DFS cycle detection on a directed graph."""
    visited: set[str] = set()
    rec_stack: set[str] = set()

    def _dfs(start: str) -> bool:
        stack = [(start, iter(graph.get(start, set())))]
        rec_stack.add(start)
        visited.add(start)
        while stack:
            current, children = stack[-1]
            try:
                child = next(children)
                if child not in visited:
                    visited.add(child)
                    rec_stack.add(child)
                    stack.append((child, iter(graph.get(child, set()))))
                elif child in rec_stack:
                    return True
            except StopIteration:
                rec_stack.discard(current)
                stack.pop()
        return False

    for node in list(graph):
        if node not in visited:
            if _dfs(node):
                return True
    return False


def detect_deadlock(block_mask: list[BlockEntry]) -> bool:
    """Return True if mutual recovery blocking exists — a directed cycle in the recovery graph."""
    graph = build_recovery_action_graph(block_mask)
    return has_cycle(graph)


# ── Sub-dimension extraction ──────────────────────────────────────────────────


def _extract_sub_dimensions(diagnostics: Diagnostics) -> list[tuple[str, float, DimensionType]]:
    """Return all ten (name, raw_value, dimension_type) tuples for tier computation."""
    bh = diagnostics.belief_health
    ch = diagnostics.coverage_health
    vh = diagnostics.verification_health
    eh = diagnostics.execution_health
    return [
        ("belief_freshness", bh.freshness, "ratio"),
        ("belief_consistency", bh.consistency, "ratio"),
        ("belief_support", bh.support, "ratio"),
        ("symptom_coverage", ch.symptom_coverage, "ratio"),
        ("explanation_coverage", ch.explanation_coverage, "ratio"),
        ("verification_strength", vh.strength, "ratio"),
        ("verification_feasibility", vh.feasibility, "ratio"),
        ("progress_rate", eh.progress_rate, "ratio"),
        # failure_recurrence and oscillation_score: 0=healthy, so invert for threshold logic
        ("failure_recurrence", 1.0 - eh.failure_recurrence, "ratio"),
        ("oscillation_score", 1.0 - eh.oscillation_score, "ratio"),
    ]


def compute_elevation_factor(sub_dims: list[tuple[str, float, Any]]) -> float:
    """Compute proportional caution elevation factor from sub-dimension values.

    Returns a value in [0,1]. Higher means more elevation toward CAUTIOUS.
    Dimensions further below CAUTION_THRESHOLD produce higher elevation.
    """
    distances: list[float] = []
    for _name, raw_value, dim_type in sub_dims:
        norm_value = normalise(raw_value, dim_type)
        if norm_value < CAUTION_THRESHOLD:
            distances.append(CAUTION_THRESHOLD - norm_value)
    if not distances:
        return 0.0
    mean_distance = sum(distances) / len(distances)
    return min(1.0, mean_distance / CAUTION_THRESHOLD)


def _compute_risk_and_confidence_estimates(sub_dims: list[tuple[str, float, Any]]) -> tuple[float, float]:
    """risk_estimate and confidence_estimate are computed from disjoint sub-dimension
    pools (_RISK_DIMENSIONS / _CONFIDENCE_DIMENSIONS) so they're genuinely distinct
    signals, not the same composite number surfaced under two names. Both continuous
    in [0,1]; a name that appears in neither pool (there shouldn't be one — see the
    module-level assertion below) is silently ignored rather than raising, since these
    are additive informational fields that must never be able to break tier resolution.
    """
    confidence_values: list[float] = []
    risk_pool_values: list[float] = []
    for name, raw_value, dim_type in sub_dims:
        norm_value = normalise(raw_value, dim_type)
        if name in _CONFIDENCE_DIMENSIONS:
            confidence_values.append(norm_value)
        elif name in _RISK_DIMENSIONS:
            risk_pool_values.append(norm_value)
    confidence_estimate = sum(confidence_values) / len(confidence_values) if confidence_values else 1.0
    risk_pool_health = sum(risk_pool_values) / len(risk_pool_values) if risk_pool_values else 1.0
    risk_estimate = max(0.0, min(1.0, 1.0 - risk_pool_health))
    return risk_estimate, confidence_estimate


# ── Five-tier resolver (P3.3) ─────────────────────────────────────────────────


def resolve_control_state(
    diagnostics: Diagnostics,
    world_model: Any,
    failure_diagnostics: Any | None = None,
    step: int | None = None,
    pending_reviewer_verdict: Any | None = None,
) -> ControlState:
    """Apply five-tier resolution to produce a ControlState, then fold in any pending
    reviewer verdict.

    PRE: asserts world_model.generation_id == step when step is provided.
    Tier 1 — SYSTEM_BREAKING contradictions → BLOCKED immediately.
    Tier 2 — Critical sub-dimension failure + deadlock detection.
    Tier 3 — Coverage gaps below CAUTION_THRESHOLD → CAUTIOUS.
    Tier 4 — Proportional caution elevation.
    Tier 5 — All clear → NORMAL.
    Tiers 3 and 4 are skipped once Tier 1 or 2 has already set permission=DENY — there is
    nothing left for them to elevate.

    pending_reviewer_verdict (Phase I / ADR-003 F-3, authority-map A-4): an
    optional ReviewerVerdict (reviewer.py) carried over from the prior
    iteration's reviewer pass. Applied once, at this function's single exit
    point below, after whichever tier fired has already set
    permission/execution_mode — advisory only, it can raise execution_mode to
    CAUTIOUS but never sets permission=DENY and never overrides a tier's own
    RECOVERY/DENY (INV-18). The caller (run_one_iteration) is responsible for
    the one-shot consume-then-clear.
    """
    from .staleness import StalenessError  # avoid circular at module level

    if step is not None and world_model.generation_id != step:
        raise StalenessError(f"world_model.generation_id={world_model.generation_id} != step={step}")

    cs = ControlState(generation_id=world_model.generation_id)
    sub_dims = _extract_sub_dimensions(diagnostics)
    # Computed once, attached regardless of which tier fires — continuous and additive,
    # so they never influence which tier fires (see _compute_risk_and_confidence_estimates'
    # own docstring on why these must never be able to break tier resolution).
    cs.risk_estimate, cs.confidence_estimate = _compute_risk_and_confidence_estimates(sub_dims)

    # ── Tier 1: SYSTEM_BREAKING contradictions ────────────────────────────────
    for contradiction in world_model.contradictions:
        if getattr(contradiction, "severity", None) == "SYSTEM_BREAKING":
            cs.permission = "DENY"
            cs.execution_mode = "RECOVERY"
            cs.escalation = "SYSTEM_BREAKING"
            cs.escalation_reason = "SYSTEM_BREAKING_CONTRADICTION"
            cs.block_mask.append(
                BlockEntry(
                    dimension="world_model_integrity",
                    value=0.0,
                    recovery_action_class="consistency_repair",
                )
            )
            break  # Tier 1 fired — Tier 2's own checks below are skipped by the guard on cs.permission.

    # ── Tier 2: Critical dimension failures ───────────────────────────────────
    if cs.permission != "DENY":
        for dim_name, raw_value, dim_type in sub_dims:
            norm_value = normalise(raw_value, dim_type)  # type: ignore[arg-type]
            assert_normalised(norm_value, dim_name)
            if norm_value < CRITICAL_THRESHOLD:
                recovery = _DIMENSION_RECOVERY.get(dim_name, "consistency_repair")
                cs.block_mask.append(
                    BlockEntry(
                        dimension=dim_name,
                        value=norm_value,
                        recovery_action_class=recovery,
                    )
                )

        if cs.block_mask:
            cs.permission = "DENY"
            cs.execution_mode = "RECOVERY"
            if detect_deadlock(cs.block_mask):
                cs.escalation = "HUMAN_REQUIRED"
                cs.escalation_reason = "HUMAN_REQUIRED"

    # ── Tiers 3 & 4: only matter if nothing above has already denied ──────────
    if cs.permission != "DENY":
        # Tier 3: Coverage gaps → CAUTIOUS
        coverage_dims = [
            ("symptom_coverage", diagnostics.coverage_health.symptom_coverage),
            ("explanation_coverage", diagnostics.coverage_health.explanation_coverage),
        ]
        for dim_name, raw_value in coverage_dims:
            norm_value = normalise(raw_value, "ratio")
            assert_normalised(norm_value, dim_name)
            if CRITICAL_THRESHOLD <= norm_value < CAUTION_THRESHOLD:
                cs.execution_mode = "CAUTIOUS"
                cs.notes.append(f"Coverage gap in {dim_name} ({norm_value:.3f}): exploration actions allowed")

        # Tier 4: Proportional caution elevation
        elevation_factor = compute_elevation_factor(sub_dims)  # type: ignore[arg-type]

        if failure_diagnostics is not None:
            matched_pattern = getattr(failure_diagnostics, "matched_pattern", None)
            if matched_pattern is not None:
                raw_confidence = getattr(matched_pattern, "confidence", 0.0)
                pattern_confidence = normalise(raw_confidence, "match_confidence")
                assert_normalised(pattern_confidence, "matched_pattern_confidence")
                elevation_factor = elevation_factor * 0.8 + pattern_confidence * 0.2

        if elevation_factor > 0.05 and cs.execution_mode == "NORMAL":
            cs.execution_mode = "CAUTIOUS"

    # ── Tier 5 / single exit point ─────────────────────────────────────────────
    # permission/execution_mode already set correctly by whichever tier(s) above fired;
    # just stamp the annotation and fold in the pending reviewer verdict once.
    _attach_annotation(cs, diagnostics)
    _apply_pending_reviewer_verdict(cs, pending_reviewer_verdict)
    return cs


def _apply_pending_reviewer_verdict(cs: ControlState, verdict: Any | None) -> None:
    """A-4 (ADR-003 authority map): a pending reviewer finding of severity >=
    MEDIUM forces execution_mode to at least CAUTIOUS — advisory only, never
    DENY; the resolver's own tiers above still own blocking (Phase I, INV-18).
    Runs after every tier has set permission/execution_mode, so it can only
    raise execution_mode from NORMAL to CAUTIOUS, never lower a tier's own
    RECOVERY back down and never touch permission."""
    if verdict is None:
        return
    severity = getattr(verdict, "severity", "LOW")
    if severity not in ("MEDIUM", "HIGH"):
        return
    cs.notes.append(f"Pending reviewer verdict ({verdict.lens}, {severity}): {verdict.summary}")
    if cs.execution_mode == "NORMAL":
        cs.execution_mode = "CAUTIOUS"


def _attach_annotation(cs: ControlState, diagnostics: Diagnostics) -> None:
    """Attach dep_class_gap_annotation to notes[] — never to arithmetic (INV-07).

    Canonical format (Phase C1, docs/adr/004): a non-empty annotation is prefixed
    with DEP_CLASS_GAP_NOTE_PREFIX; an absent (None) or explicit empty-string
    annotation adds no note. Mirrors resolve-control-state.ts exactly — this
    retired the two tracked dep_class_gap discrepancies in
    scripts/harness-conformance/known-discrepancies.json.
    """
    if diagnostics.dep_class_gap_annotation:
        cs.notes.append(f"{DEP_CLASS_GAP_NOTE_PREFIX}{diagnostics.dep_class_gap_annotation}")
