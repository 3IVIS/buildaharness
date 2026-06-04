"""
Control state, deadlock detection, and resolve_control_state() — P3.3 and P3.4.

ControlState is the sole control input for action selection (INV-06).
resolve_control_state() applies five tiers in strict order.
detect_deadlock() uses directed cycle detection on the recovery-action graph.
dep_class_gap_annotation is attached to notes[] only — never enters arithmetic (INV-07).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from .diagnostics import (
    Diagnostics,
    DimensionType,
    assert_normalised,
    normalise,
)

RiskState = Literal["NORMAL", "CAUTIOUS", "BLOCKED"]

CRITICAL_THRESHOLD: float = 0.2
CAUTION_THRESHOLD: float = 0.4

# Maps recovery_action_class → set of dimension names it requires to be unblocked.
# A recovery action must NOT depend on the dimension it is recovering — otherwise
# a single blocked dimension would always detect as a deadlock (self-loop).
RECOVERY_ACTION_DEPENDENCIES: dict[str, set[str]] = {
    "dep_graph_refresh": {"verification_strength"},  # refresh dep graph → needs verification
    "verification_pass": {"dep_graph_quality"},  # run verification → needs dep graph
    "belief_refresh": {"verification_feasibility"},  # refresh beliefs → needs feasibility
    "coverage_expand": {"verification_strength"},  # expand coverage → needs verification
    "execution_retry": {"dep_graph_quality"},  # retry execution → needs dep graph
    "oscillation_stabilise": {"belief_freshness"},  # stabilise → needs fresh beliefs
    "failure_recovery": {"dep_graph_quality"},  # recover from failure → needs dep graph
    "consistency_repair": {"verification_strength"},  # repair consistency → needs verification
    "support_augment": {"belief_freshness"},  # augment support → needs fresh beliefs
    "feasibility_check": {"dep_graph_quality"},  # check feasibility → needs dep graph
    "explanation_expand": {"belief_freshness"},  # expand explanations → needs fresh beliefs
}

_DIMENSION_RECOVERY: dict[str, str] = {
    "belief_freshness": "belief_refresh",
    "belief_consistency": "consistency_repair",
    "belief_support": "support_augment",
    "symptom_coverage": "coverage_expand",
    "explanation_coverage": "explanation_expand",
    "verification_strength": "verification_pass",
    "verification_feasibility": "feasibility_check",
    "progress_rate": "execution_retry",
    "failure_recurrence": "failure_recovery",
    "oscillation_score": "oscillation_stabilise",
    "dep_graph_quality": "dep_graph_refresh",
    "world_model_integrity": "consistency_repair",
}


@dataclass
class BlockEntry:
    dimension: str
    value: float
    recovery_action_class: str


@dataclass
class ControlState:
    generation_id: int = 0
    risk_state: RiskState = "NORMAL"
    escalation_reason: str | None = None
    block_mask: list[BlockEntry] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "generation_id": self.generation_id,
            "risk_state": self.risk_state,
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
            risk_state=d.get("risk_state", "NORMAL"),
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


# ── Five-tier resolver (P3.3) ─────────────────────────────────────────────────


def resolve_control_state(
    diagnostics: Diagnostics,
    world_model: Any,
    failure_diagnostics: Any | None = None,
    step: int | None = None,
) -> ControlState:
    """Apply five-tier resolution to produce a ControlState.

    PRE: asserts world_model.generation_id == step when step is provided.
    Tier 1 — SYSTEM_BREAKING contradictions → BLOCKED immediately.
    Tier 2 — Critical sub-dimension failure + deadlock detection.
    Tier 3 — Coverage gaps below CAUTION_THRESHOLD → CAUTIOUS.
    Tier 4 — Proportional caution elevation.
    Tier 5 — All clear → NORMAL.
    """
    from .staleness import StalenessError  # avoid circular at module level

    if step is not None and world_model.generation_id != step:
        raise StalenessError(f"world_model.generation_id={world_model.generation_id} != step={step}")

    cs = ControlState(generation_id=world_model.generation_id)
    sub_dims = _extract_sub_dimensions(diagnostics)

    # ── Tier 1: SYSTEM_BREAKING contradictions ────────────────────────────────
    for contradiction in world_model.contradictions:
        if getattr(contradiction, "severity", None) == "SYSTEM_BREAKING":
            cs.risk_state = "BLOCKED"
            cs.escalation_reason = "SYSTEM_BREAKING_CONTRADICTION"
            cs.block_mask.append(
                BlockEntry(
                    dimension="world_model_integrity",
                    value=0.0,
                    recovery_action_class="consistency_repair",
                )
            )
            _attach_annotation(cs, diagnostics)
            return cs

    # ── Tier 2: Critical dimension failures ───────────────────────────────────
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
        cs.risk_state = "BLOCKED"
        if detect_deadlock(cs.block_mask):
            cs.escalation_reason = "HUMAN_REQUIRED"
        _attach_annotation(cs, diagnostics)
        return cs

    # ── Tier 3: Coverage gaps → CAUTIOUS ──────────────────────────────────────
    coverage_dims = [
        ("symptom_coverage", diagnostics.coverage_health.symptom_coverage),
        ("explanation_coverage", diagnostics.coverage_health.explanation_coverage),
    ]
    for dim_name, raw_value in coverage_dims:
        norm_value = normalise(raw_value, "ratio")
        assert_normalised(norm_value, dim_name)
        if CRITICAL_THRESHOLD <= norm_value < CAUTION_THRESHOLD:
            cs.risk_state = "CAUTIOUS"
            cs.notes.append(f"Coverage gap in {dim_name} ({norm_value:.3f}): exploration actions allowed")

    # ── Tier 4: Proportional caution elevation ────────────────────────────────
    elevation_factor = compute_elevation_factor(sub_dims)  # type: ignore[arg-type]

    if failure_diagnostics is not None:
        matched_pattern = getattr(failure_diagnostics, "matched_pattern", None)
        if matched_pattern is not None:
            raw_confidence = getattr(matched_pattern, "confidence", 0.0)
            pattern_confidence = normalise(raw_confidence, "match_confidence")
            assert_normalised(pattern_confidence, "matched_pattern_confidence")
            elevation_factor = elevation_factor * 0.8 + pattern_confidence * 0.2

    if elevation_factor > 0.05 and cs.risk_state == "NORMAL":
        cs.risk_state = "CAUTIOUS"

    # ── Tier 5: All clear ─────────────────────────────────────────────────────
    # risk_state already set correctly; just stamp the generation_id
    _attach_annotation(cs, diagnostics)
    return cs


def _attach_annotation(cs: ControlState, diagnostics: Diagnostics) -> None:
    """Attach dep_class_gap_annotation to notes[] — never to arithmetic (INV-07)."""
    if diagnostics.dep_class_gap_annotation is not None:
        cs.notes.append(diagnostics.dep_class_gap_annotation)
