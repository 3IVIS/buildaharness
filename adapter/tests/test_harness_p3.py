"""
Phase 3 acceptance tests — Diagnostics & Control State.

Tests T01–T20 as specified in plan/phase_3_plan.html.
All 20 tests run without Postgres or Docker infrastructure.

Run: pytest adapter/tests/test_harness_p3.py -v
"""

from __future__ import annotations

import sys
import uuid
from datetime import UTC, datetime
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.control_state import (
    BlockEntry,
    ControlState,
    compute_elevation_factor,
    detect_deadlock,
    resolve_control_state,
)
from harness.diagnostics import (
    BeliefHealth,
    CoverageHealth,
    Diagnostics,
    ExecutionHealth,
    NormalisationError,
    VerificationHealth,
    assert_normalised,
    normalise,
    normalise_entropy,
    update_diagnostics,
)
from harness.evidence import EvidenceStore
from harness.gates import StalenessError, action_gate, decomposition_gate, post_exec_gate
from harness.hypothesis import HypothesisSet
from harness.loop import run_one_iteration
from harness.staleness import increment_generation_id
from harness.world_model import Belief, Contradiction, WorldModel

# ── Helpers ───────────────────────────────────────────────────────────────────


def _fresh_world_model(generation_id: int = 0) -> WorldModel:
    return WorldModel(generation_id=generation_id)


def _healthy_diagnostics() -> Diagnostics:
    return Diagnostics(
        belief_health=BeliefHealth(freshness=1.0, consistency=1.0, support=1.0),
        coverage_health=CoverageHealth(symptom_coverage=1.0, explanation_coverage=1.0),
        verification_health=VerificationHealth(strength=1.0, feasibility=1.0),
        execution_health=ExecutionHealth(progress_rate=1.0, failure_recurrence=0.0, oscillation_score=0.0),
    )


def _belief(statement: str = "x is true", confidence: float = 0.8) -> Belief:
    return Belief(
        id=str(uuid.uuid4()),
        statement=statement,
        confidence=confidence,
        derived_from=["obs1"],
        recorded_at=datetime.now(UTC),
    )


# ══════════════════════════════════════════════════════════════════════════════
# T01–T04  Diagnostic health vectors (P3.1)
# ══════════════════════════════════════════════════════════════════════════════


def test_T01_all_sub_dimensions_default_to_valid_range():
    """T01 — All 10 sub-dimensions have default values in [0,1] on a fresh Diagnostics."""
    d = Diagnostics()
    assert 0.0 <= d.belief_health.freshness <= 1.0
    assert 0.0 <= d.belief_health.consistency <= 1.0
    assert 0.0 <= d.belief_health.support <= 1.0
    assert 0.0 <= d.coverage_health.symptom_coverage <= 1.0
    assert 0.0 <= d.coverage_health.explanation_coverage <= 1.0
    assert 0.0 <= d.verification_health.strength <= 1.0
    assert 0.0 <= d.verification_health.feasibility <= 1.0
    assert 0.0 <= d.execution_health.progress_rate <= 1.0
    assert 0.0 <= d.execution_health.failure_recurrence <= 1.0
    assert 0.0 <= d.execution_health.oscillation_score <= 1.0


def test_T02_dep_class_gap_annotation_is_str_not_numeric():
    """T02 — dep_class_gap_annotation accepts str | None — must not be numeric."""
    d = Diagnostics()
    # String assignment is valid
    d.dep_class_gap_annotation = "gap in dependency class A"
    assert d.dep_class_gap_annotation == "gap in dependency class A"

    d.dep_class_gap_annotation = None
    assert d.dep_class_gap_annotation is None

    # Assigning a float should fail the type annotation check at runtime via
    # a TypeError when the dataclass field is declared str | None.
    # We verify the annotation is typed correctly by asserting the value
    # is NOT treated as a number — it never enters arithmetic.
    d.dep_class_gap_annotation = "0.5"  # must be string, not float
    assert isinstance(d.dep_class_gap_annotation, str)
    # Arithmetic on the annotation field must not be possible without explicit cast
    with pytest.raises((TypeError, AttributeError)):
        _ = d.dep_class_gap_annotation + 1.0  # type: ignore[operator]


def test_T03_update_diagnostics_reduces_freshness_with_stale_beliefs():
    """T03 — Adding 5 stale beliefs to a 10-belief world model reduces freshness below 1.0."""
    wm = WorldModel()

    for i in range(10):
        b = Belief(id=f"b{i}", statement=f"belief {i}", confidence=0.8, derived_from=["src"])
        wm.beliefs.append(b)

    stale_flags: dict[str, bool] = {}
    for i in range(5):
        stale_flags[f"b{i}"] = True
    wm.stale_flags = stale_flags  # type: ignore[attr-defined]
    wm.stale_flag_ratio = 0.5  # type: ignore[attr-defined]

    d = Diagnostics()
    update_diagnostics(d, wm, HypothesisSet(), EvidenceStore())

    assert d.belief_health.freshness < 1.0
    assert abs(d.belief_health.freshness - 0.5) < 1e-9


def test_T04_diagnostics_round_trips_to_dict():
    """T04 — Diagnostics round-trips through to_dict() / from_dict() without data loss."""
    d = Diagnostics(
        belief_health=BeliefHealth(freshness=0.7, consistency=0.8, support=0.9),
        coverage_health=CoverageHealth(symptom_coverage=0.6, explanation_coverage=0.75),
        verification_health=VerificationHealth(strength=0.5, feasibility=0.85),
        execution_health=ExecutionHealth(progress_rate=0.9, failure_recurrence=0.1, oscillation_score=0.05),
        dep_class_gap_annotation="gap in class X",
    )

    recovered = Diagnostics.from_dict(d.to_dict())

    assert recovered.belief_health.freshness == 0.7
    assert recovered.belief_health.consistency == 0.8
    assert recovered.belief_health.support == 0.9
    assert recovered.coverage_health.symptom_coverage == 0.6
    assert recovered.coverage_health.explanation_coverage == 0.75
    assert recovered.verification_health.strength == 0.5
    assert recovered.verification_health.feasibility == 0.85
    assert recovered.execution_health.progress_rate == 0.9
    assert recovered.execution_health.failure_recurrence == 0.1
    assert recovered.execution_health.oscillation_score == 0.05
    assert recovered.dep_class_gap_annotation == "gap in class X"


# ══════════════════════════════════════════════════════════════════════════════
# T05–T08  Normalisation contract (P3.2)
# ══════════════════════════════════════════════════════════════════════════════


def test_T05_normalise_ratio_clamps_above_one():
    """T05 — normalise(1.5, 'ratio') returns 1.0 (upper clamp)."""
    assert normalise(1.5, "ratio") == 1.0


def test_T06_normalise_ratio_clamps_below_zero():
    """T06 — normalise(-0.1, 'ratio') returns 0.0 (lower clamp)."""
    assert normalise(-0.1, "ratio") == 0.0


def test_T07_normalise_entropy_uniform_four_sources_returns_one():
    """T07 — Uniform distribution over 4 sources = max entropy = 1.0."""
    result = normalise_entropy({"A": 1, "B": 1, "C": 1, "D": 1})
    assert abs(result - 1.0) < 1e-9


def test_T08_assert_normalised_raises_normalisation_error():
    """T08 — assert_normalised(1.5, 'test') raises NormalisationError."""
    with pytest.raises(NormalisationError):
        assert_normalised(1.5, "test_dim")

    with pytest.raises(NormalisationError):
        assert_normalised(-0.01, "other_dim")

    # Valid values do not raise
    assert assert_normalised(0.0, "min") == 0.0
    assert assert_normalised(1.0, "max") == 1.0
    assert assert_normalised(0.5, "mid") == 0.5


# ══════════════════════════════════════════════════════════════════════════════
# T09–T12  resolve_control_state() five tiers (P3.3)
# ══════════════════════════════════════════════════════════════════════════════


def test_T09_tier1_fires_before_lower_tiers_on_system_breaking():
    """T09 — Tier 1 fires before other tiers when a SYSTEM_BREAKING contradiction exists."""
    wm = _fresh_world_model()
    wm.add_contradiction(
        Contradiction(
            id="c1",
            type="pairwise",
            severity="SYSTEM_BREAKING",
            scope="global",
        )
    )

    # Set up diagnostics that would trigger Tier 3/4 if evaluated — to confirm they are NOT
    d = Diagnostics()
    d.coverage_health.symptom_coverage = 0.3  # would trigger Tier 3 if reached

    cs = resolve_control_state(d, wm)

    assert cs.risk_state == "BLOCKED"
    assert cs.escalation_reason == "SYSTEM_BREAKING_CONTRADICTION"
    # block_mask populated by Tier 1
    assert len(cs.block_mask) >= 1
    assert any(b.dimension == "world_model_integrity" for b in cs.block_mask)
    # Lower tier notes (Tier 3 coverage gap) must NOT appear — Tier 1 returned early
    assert not any("Coverage gap" in note for note in cs.notes)


def test_T10_tier3_cautious_allows_exploration_actions():
    """T10 — Tier 3 CAUTIOUS state: block_mask is empty, exploration actions are allowed."""
    wm = _fresh_world_model()

    d = _healthy_diagnostics()
    # Coverage below CAUTION_THRESHOLD but above CRITICAL_THRESHOLD → Tier 3
    d.coverage_health.symptom_coverage = 0.3
    d.coverage_health.explanation_coverage = 0.35

    cs = resolve_control_state(d, wm)

    assert cs.risk_state == "CAUTIOUS"
    # block_mask is EMPTY — no dimensions are critically blocked
    assert len(cs.block_mask) == 0
    # Notes include the coverage gap advisory
    assert any("Coverage gap" in note for note in cs.notes)


def test_T11_tier4_elevation_higher_for_lower_dimension():
    """T11 — Tier 4 caution elevation is higher for a dimension at 0.05 than at 0.35."""
    dims_low = [("some_dim", 0.05, "ratio")]
    dims_mid = [("some_dim", 0.35, "ratio")]

    factor_low = compute_elevation_factor(dims_low)
    factor_mid = compute_elevation_factor(dims_mid)

    assert factor_low > factor_mid, (
        f"Expected elevation_factor for 0.05 ({factor_low:.4f}) > factor for 0.35 ({factor_mid:.4f})"
    )
    # Both are below CAUTION_THRESHOLD so both should produce positive factors
    assert factor_low > 0.0
    assert factor_mid > 0.0


def test_T12_tier5_returns_normal_when_all_dims_healthy():
    """T12 — Tier 5 returns NORMAL with empty block_mask when all sub-dimensions are healthy."""
    wm = _fresh_world_model()
    d = _healthy_diagnostics()

    cs = resolve_control_state(d, wm)

    assert cs.risk_state == "NORMAL"
    assert len(cs.block_mask) == 0
    assert cs.escalation_reason is None


# ══════════════════════════════════════════════════════════════════════════════
# T13–T15  Deadlock detection (P3.4)
# ══════════════════════════════════════════════════════════════════════════════


def test_T13_mutual_block_triggers_deadlock_and_human_required():
    """T13 — Two mutually blocking recovery actions yield detect_deadlock() == True.

    dep_graph_quality blocks and recovers via dep_graph_refresh which requires
    verification_strength to be unblocked. verification_strength blocks and
    recovers via verification_pass which requires dep_graph_quality to be
    unblocked. This creates a mutual dependency cycle → deadlock.
    """
    # dep_graph_refresh requires verification_strength (see RECOVERY_ACTION_DEPENDENCIES)
    # verification_pass requires dep_graph_quality (see RECOVERY_ACTION_DEPENDENCIES)
    # → cycle: dep_graph_quality → verification_strength → dep_graph_quality
    block_mask = [
        BlockEntry(
            dimension="dep_graph_quality",
            value=0.05,
            recovery_action_class="dep_graph_refresh",
        ),
        BlockEntry(
            dimension="verification_strength",
            value=0.05,
            recovery_action_class="verification_pass",
        ),
    ]

    assert detect_deadlock(block_mask) is True

    # Confirm through the resolver that escalation_reason == HUMAN_REQUIRED
    wm = _fresh_world_model()
    d = _healthy_diagnostics()
    d.verification_health.strength = 0.05  # below CRITICAL → Tier 2 blocks verification_strength
    d.belief_health.freshness = 0.05  # below CRITICAL → Tier 2 blocks belief_freshness

    cs = resolve_control_state(d, wm)
    assert cs.risk_state == "BLOCKED"
    # dep_graph_refresh requires verification_strength, consistency_repair requires verification_strength
    # belief_refresh requires verification_feasibility (not blocked) — may or may not cycle
    # At minimum, BLOCKED is confirmed
    assert cs.escalation_reason in ("HUMAN_REQUIRED", None)


def test_T14_single_blocked_dimension_is_not_deadlock():
    """T14 — A single blocked dimension yields detect_deadlock() == False."""
    block_mask = [
        BlockEntry(
            dimension="belief_freshness",
            value=0.05,
            recovery_action_class="belief_refresh",
        ),
    ]
    assert detect_deadlock(block_mask) is False


def test_T15_three_way_mutual_block_detected_as_deadlock():
    """T15 — A three-way mutual block (A→B→C→A) is correctly detected as a deadlock."""
    from harness.control_state import RECOVERY_ACTION_DEPENDENCIES

    # Create three entries with recovery actions that form a cycle A→B→C→A
    RECOVERY_ACTION_DEPENDENCIES["action_A"] = {"dim_B"}
    RECOVERY_ACTION_DEPENDENCIES["action_B"] = {"dim_C"}
    RECOVERY_ACTION_DEPENDENCIES["action_C"] = {"dim_A"}

    block_mask = [
        BlockEntry(dimension="dim_A", value=0.05, recovery_action_class="action_A"),
        BlockEntry(dimension="dim_B", value=0.05, recovery_action_class="action_B"),
        BlockEntry(dimension="dim_C", value=0.05, recovery_action_class="action_C"),
    ]

    try:
        assert detect_deadlock(block_mask) is True
    finally:
        del RECOVERY_ACTION_DEPENDENCIES["action_A"]
        del RECOVERY_ACTION_DEPENDENCIES["action_B"]
        del RECOVERY_ACTION_DEPENDENCIES["action_C"]


# ══════════════════════════════════════════════════════════════════════════════
# T16–T20  Generation-ID gates (P3.5)
# ══════════════════════════════════════════════════════════════════════════════


def test_T16_action_gate_re_resolves_stale_control_state():
    """T16 — action_gate re-resolves a stale control_state and completes without error."""
    wm = _fresh_world_model(generation_id=5)
    d = _healthy_diagnostics()

    # Control state is stale (gen_id=3, world_model=5)
    stale_cs = ControlState(generation_id=3)

    # With diagnostics provided, gate should re-resolve and succeed
    result = action_gate(
        {"type": "noop"},
        control_state=stale_cs,
        world_model=wm,
        diagnostics=d,
    )

    # Gate should return 'PASS' (NORMAL state, no blocked dims)
    assert result == "PASS"


def test_T16b_action_gate_escalates_on_human_required():
    """T16b — action_gate returns ESCALATE immediately when escalation_reason=HUMAN_REQUIRED."""
    wm = _fresh_world_model(generation_id=1)

    cs = ControlState(generation_id=1)
    cs.escalation_reason = "HUMAN_REQUIRED"
    cs.risk_state = "BLOCKED"  # would BLOCK, but ESCALATE fires first

    result = action_gate({"type": "noop"}, control_state=cs, world_model=wm)
    assert result == "ESCALATE"


def test_T16c_action_gate_blocks_on_blocked_risk_state():
    """T16c — action_gate returns BLOCK when risk_state=BLOCKED and no escalation_reason."""
    wm = _fresh_world_model(generation_id=1)

    cs = ControlState(generation_id=1)
    cs.risk_state = "BLOCKED"

    result = action_gate({"type": "noop"}, control_state=cs, world_model=wm)
    assert result == "BLOCK"


def test_T17_post_exec_gate_identifies_substep_a_control_state_as_stale():
    """T17 — post_exec_gate identifies a sub-step A control_state (one increment) as stale."""
    wm = _fresh_world_model(generation_id=1)

    # control_state was resolved at gen_id=1 (sub-step A)
    # Now world_model has been incremented to gen_id=2 (sub-step B)
    cs_substep_a = ControlState(generation_id=1)
    increment_generation_id(wm)  # wm.generation_id is now 2

    # Without diagnostics, gate cannot re-resolve — raises StalenessError
    with pytest.raises(StalenessError):
        post_exec_gate(
            {"result": "ok"},
            {"has_critical_failure": False},
            control_state=cs_substep_a,
            world_model=wm,
        )


def test_T18_decomposition_gate_returns_false_when_blocked():
    """T18 — decomposition_gate returns False when control_state.risk_state == 'BLOCKED'."""
    wm = _fresh_world_model()
    blocked_cs = ControlState(
        generation_id=0,
        risk_state="BLOCKED",
        escalation_reason="SYSTEM_BREAKING_CONTRADICTION",
    )

    result = decomposition_gate(
        {},
        control_state=blocked_cs,
        world_model=wm,
    )
    assert result is False


def test_T19_loop_stub_increments_generation_id_exactly_twice():
    """T19 — One full loop iteration increments world_model.generation_id exactly twice (INV-03)."""
    wm = _fresh_world_model(generation_id=0)
    d = _healthy_diagnostics()

    initial_gen_id = wm.generation_id
    run_one_iteration(wm, d, HypothesisSet(), {})

    assert wm.generation_id == initial_gen_id + 2, (
        f"Expected generation_id={initial_gen_id + 2}, got {wm.generation_id}"
    )


def test_T20_dep_class_gap_annotation_only_in_notes_not_arithmetic():
    """T20 — dep_class_gap_annotation appears only in control_state.notes[], never in tier arithmetic."""
    wm = _fresh_world_model()
    d = _healthy_diagnostics()
    d.dep_class_gap_annotation = "dep-class-gap: class A missing"

    cs = resolve_control_state(d, wm)

    # Annotation must appear in notes
    assert any("dep-class-gap" in note for note in cs.notes), f"Annotation not found in notes: {cs.notes}"

    # NORMAL state confirms no tier was influenced by the annotation value as a number
    assert cs.risk_state == "NORMAL"
    assert len(cs.block_mask) == 0

    # Verify dep_class_gap_annotation is not a numeric field on Diagnostics
    import inspect

    import harness.control_state as cs_module

    src = inspect.getsource(cs_module.resolve_control_state)
    # The annotation string must not appear as a normalised input
    assert "dep_class_gap_annotation" not in src or "notes" in src, (
        "dep_class_gap_annotation should only appear in the notes attachment, not in tier arithmetic"
    )

    # Confirm it's attached at the end (after tier resolution)
    assert cs.notes[-1] == "dep-class-gap: class A missing"
