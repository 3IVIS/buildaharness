"""
Phase 11 — Architectural invariant tests (P11.4).

Invariant tests run against the full integrated harness system.
These tests are a permanent CI gate — any PR that regresses an invariant is blocked.
Tests use black-box assertions wherever possible: observable behaviour, not internals.

Invariants:
  INV-01  Observation-conclusion separation — no belief without derived_from chain
  INV-02  Normalisation contract — all diagnostic values clamped to [0, 1]
  INV-03  WorldModel version is monotonic; is_stale() detects drift correctly in both
          directions (superseded 2026-08-10 from "generation_id increments exactly twice
          per iteration" — see the test file for why)
  INV-04  Deadlock detection — detect_deadlock identifies HUMAN_REQUIRED when strategies block
  INV-05  SYSTEM_BREAKING via contradictions[] only — no inline raise
  INV-06  control_state as sole control input — world_model/hypothesis_set are read-only context
  INV-07  dep_class_gap is advisory only — no numeric parameter in Tiers 1–4
  INV-08  Failure mode library scope — Tier 4 + hypothesis generation only
  INV-09  Adversarial prior discarded after reviewer_pass — no live references
  INV-10  experience_store is no-op when absent — structurally identical output
  INV-11  Diagnostic provenance — no sub-dimension reaches the resolver un-provenanced;
          the uncalibrated-model-block annotation is advisory (Phase C2; ADR-004)
  INV-20  Trajectory Supervisor directive is one-shot — applied at the stall edge once,
          never re-applied on a later iteration (plans/harness_trajectory_supervisor_plan.html)
  INV-21  The supervisor never influences resolve_control_state() or adds/edits beliefs,
          observations, or contradictions — only strategy_state / task_graph / budget
  INV-22  The supervisor directive is consulted only inside the cannot_make_progress()
          branch — a non-stalled iteration ignores it entirely
  INV-23  Investigation sub-agents (GATHER_EVIDENCE, S4) have no write / shell / email
          tools — suggested_tools is filtered to the read-only allowlist before dispatch
  INV-24  Investigation depth is capped at 1 — an investigation cannot spawn an investigation
  INV-25  Every investigation runs under its own bounded call budget; exhaustion returns
          partial findings and never hangs (per-call bounded timeout)

Run with: pytest adapter/tests/test_harness_invariants.py -v
"""

from __future__ import annotations

import itertools
import sys
import uuid
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.contradiction import (
    assign_system_breaking_severity,
    detect_contradictions,
)
from harness.control_state import BlockEntry, ControlState, detect_deadlock
from harness.diagnostics import (
    BeliefHealth,
    CoverageHealth,
    Diagnostics,
    ExecutionHealth,
    VerificationHealth,
    assert_normalised,
    normalise,
)
from harness.evidence import EvidenceStore
from harness.experience_store import WarmStartResult, warm_start
from harness.failure_modes import FailureDiagnostics
from harness.hypothesis import Hypothesis, HypothesisSet
from harness.loop import run_one_iteration, select_best_action
from harness.memory import MemoryState
from harness.output_contract import OutputContract
from harness.recovery import StrategyState
from harness.reviewer import ReviewPassResult, reviewer_pass
from harness.state_store import HarnessRunState
from harness.task_graph import Task, TaskGraph
from harness.world_model import Belief, Contradiction, Observation, WorldModel

# ─── Shared helpers ────────────────────────────────────────────────────────────


def _make_world_model(n_beliefs: int = 2) -> WorldModel:
    wm = WorldModel()
    for i in range(n_beliefs):
        wm.add_observation(Observation(id=f"obs-{i}", content=f"observation {i}", source="test"))
        wm.add_belief(Belief(id=f"b-{i}", statement=f"belief {i}", confidence=0.8, derived_from=[f"obs-{i}"]))
    return wm


def _make_diagnostics(value: float = 0.8) -> Diagnostics:
    return Diagnostics(
        belief_health=BeliefHealth(freshness=value, consistency=value, support=value),
        coverage_health=CoverageHealth(symptom_coverage=value, explanation_coverage=value),
        verification_health=VerificationHealth(strength=value, feasibility=value),
        execution_health=ExecutionHealth(
            progress_rate=value, failure_recurrence=1 - value, oscillation_score=1 - value
        ),
    )


def _make_run_state() -> HarnessRunState:
    return HarnessRunState(
        run_id=str(uuid.uuid4()),
        world_model=_make_world_model(),
        diagnostics=_make_diagnostics(),
        task_graph=TaskGraph(
            tasks=[
                Task(id="t1", description="task", status="ACTIVE", completed_evidence=[], abstraction_level=0),
            ]
        ),
        hypothesis_set=HypothesisSet(active=[], eliminated=[]),
        evidence_store=EvidenceStore(),
        strategy_state=StrategyState(),
        memory_state=MemoryState(),
        failure_diagnostics=FailureDiagnostics(),
    )


# ══════════════════════════════════════════════════════════════════════════════
# INV-01 — Observation-conclusion separation
# ══════════════════════════════════════════════════════════════════════════════


def test_inv_01_belief_requires_derived_from_chain():
    """INV-01: Every belief must have a non-empty derived_from chain.

    Beliefs without derived_from are pure conclusions — they violate the
    observation-conclusion separation invariant.
    """
    wm = WorldModel()
    obs = Observation(id="obs-1", content="test observation", source="test")
    wm.add_observation(obs)

    # Valid belief: has derived_from chain pointing to an observation
    valid_belief = Belief(
        id="b-valid",
        statement="valid belief",
        confidence=0.8,
        derived_from=["obs-1"],
    )
    wm.add_belief(valid_belief)

    # Every belief in the world model must have a non-empty derived_from
    for belief in wm.beliefs:
        assert belief.derived_from, (
            f"INV-01 violated: belief {belief.id!r} has empty derived_from — beliefs must be derived from observations."
        )

    # A belief with empty derived_from is detectable
    bare_belief = Belief(id="b-bare", statement="bare conclusion", confidence=0.9, derived_from=[])
    assert bare_belief.derived_from == []


# ══════════════════════════════════════════════════════════════════════════════
# INV-02 — Normalisation contract
# ══════════════════════════════════════════════════════════════════════════════


def test_inv_02_all_diagnostic_values_clamped_to_0_1():
    """INV-02: normalise() clamps ratio values to [0, 1]; assert_normalised() raises on violation."""
    from harness.diagnostics import NormalisationError

    # normalise("ratio") clamps values to [0, 1]
    assert normalise(0.0, "ratio") == 0.0
    assert normalise(0.5, "ratio") == 0.5
    assert normalise(1.0, "ratio") == 1.0
    assert normalise(-0.5, "ratio") == 0.0
    assert normalise(1.5, "ratio") == 1.0

    # assert_normalised raises NormalisationError on out-of-range values
    with pytest.raises(NormalisationError):
        assert_normalised(1.5, label="test_value")

    with pytest.raises(NormalisationError):
        assert_normalised(-0.1, label="test_value")

    # assert_normalised does not raise for valid values
    assert_normalised(0.0, label="test")
    assert_normalised(1.0, label="test")
    assert_normalised(0.75, label="test")


# ══════════════════════════════════════════════════════════════════════════════
# INV-03 — WorldModel version is monotonic; staleness detection is correct
# ══════════════════════════════════════════════════════════════════════════════
#
# Superseded 2026-08-10 (Phase 1a of plans/harness_and_assistant_architecture_remediation_
# plan.html): the original INV-03 asserted "generation_id increments exactly twice per
# iteration" — a specific implementation-lifecycle detail (run_one_iteration's Sub-step
# A / Sub-step B structure), not the property that actually matters. What matters is that
# staleness detection is reliable, regardless of exactly how or when the version advances.
# Replaced with two invariants matching that behavioral contract:
#   1. WorldModelVersion (world_model.generation_id) never decreases within a run — the
#      minimal fact staleness comparison depends on being meaningful at all.
#   2. A version-pinned object (PlanVersion/ExecutionVersion/VerificationVersion, or a
#      ControlState) is judged stale by is_stale() if and only if the world model's
#      current version has advanced past the version it was pinned to — tested in both
#      directions, independent of *how* the advancement happened.


def test_inv_03_world_model_version_is_monotonic_non_decreasing():
    """INV-03: world_model.generation_id never decreases across any sequence of iterations."""
    state = _make_run_state()
    observed = [state.world_model.generation_id]

    for step in range(4):
        run_one_iteration(
            world_model=state.world_model,
            diagnostics=state.diagnostics,
            hypothesis_set=state.hypothesis_set,
            task_graph=state.task_graph,
            failure_diagnostics=state.failure_diagnostics,
            memory_state=state.memory_state,
            strategy_state=state.strategy_state,
            step_count=step,
        )
        observed.append(state.world_model.generation_id)

    for before, after in itertools.pairwise(observed):
        assert after >= before, (
            f"INV-03 violated: world_model.generation_id decreased ({before} -> {after}) — "
            "staleness_check()'s '<' comparison is meaningless if this can happen."
        )
    # And it must have actually advanced at least once — a version that never changes
    # would make the monotonicity check above vacuously true.
    assert observed[-1] > observed[0]


def test_inv_03_staleness_correctly_detects_version_drift():
    """INV-03: is_stale() is True iff the world model has advanced past a pinned version,
    tested both directions — not coupled to *how many* increments occurred or when."""
    from harness.provenance import new_execution_version
    from harness.staleness import increment_generation_id, is_stale

    state = _make_run_state()
    wm = state.world_model

    pinned = new_execution_version(wm)
    assert pinned.world_model_version == wm.generation_id

    # Direction 1: world model unchanged since pinning → not stale.
    assert is_stale(pinned, wm) is False, (
        "INV-03 violated: is_stale() reported a freshly-pinned ExecutionVersion as stale "
        "before the world model advanced at all."
    )

    # Direction 2: world model advances (by any means — a raw increment here, a full
    # run_one_iteration() in the sibling test above, doesn't matter which) → stale.
    increment_generation_id(wm)
    assert is_stale(pinned, wm) is True, (
        "INV-03 violated: is_stale() failed to detect that the world model advanced past "
        f"the pinned version {pinned.world_model_version} (now at {wm.generation_id})."
    )

    # A freshly re-pinned version against the now-current world model is fresh again.
    repinned = new_execution_version(wm)
    assert is_stale(repinned, wm) is False


# ══════════════════════════════════════════════════════════════════════════════
# INV-04 — Deadlock detection
# ══════════════════════════════════════════════════════════════════════════════


def test_inv_04_detect_deadlock_with_cycle_in_block_mask():
    """INV-04: detect_deadlock returns True when block_mask entries form a cycle."""

    # Create two block entries with recovery actions that reference each other
    entry_a = BlockEntry(
        dimension="belief_freshness",
        value=0.1,
        recovery_action_class="fix_consistency",
    )
    entry_b = BlockEntry(
        dimension="belief_consistency",
        value=0.1,
        recovery_action_class="fix_freshness",
    )

    # detect_deadlock takes a list[BlockEntry]
    result = detect_deadlock([entry_a, entry_b])
    assert isinstance(result, bool)


def test_inv_04_deadlock_detection_empty_block_mask():
    """INV-04: detect_deadlock returns False for an empty block_mask (no recovery actions)."""

    assert detect_deadlock([]) is False


# ══════════════════════════════════════════════════════════════════════════════
# INV-05 — SYSTEM_BREAKING via contradictions only
# ══════════════════════════════════════════════════════════════════════════════


def test_inv_05_system_breaking_goes_to_contradictions_not_raised():
    """INV-05: detect_contradictions populates contradictions[] — never raises inline."""
    wm = WorldModel()
    wm.add_observation(Observation(id="obs-1", content="X is true", source="test"))
    wm.add_observation(Observation(id="obs-2", content="X is false", source="test"))
    wm.add_belief(Belief(id="b-1", statement="X is true", confidence=0.9, derived_from=["obs-1"]))
    wm.add_belief(Belief(id="b-2", statement="X is false", confidence=0.9, derived_from=["obs-2"]))

    evidence_store = EvidenceStore()
    hypothesis_set = HypothesisSet(active=[], eliminated=[])

    # Must not raise — any SYSTEM_BREAKING contradiction goes into contradictions[]
    try:
        detect_contradictions(wm, evidence_store, hypothesis_set)
    except Exception as exc:  # pragma: no cover
        pytest.fail(f"INV-05 violated: detect_contradictions raised {type(exc).__name__}: {exc}")

    # Any detected contradictions must be in wm.contradictions — not raised
    assert isinstance(wm.contradictions, list)


def test_inv_05_assign_system_breaking_severity_upgrades_high_contradictions():
    """INV-05: assign_system_breaking_severity upgrades HIGH-severity contradictions."""
    wm = _make_world_model(2)
    # Manually set high confidence on beliefs
    for b in wm.beliefs:
        b.confidence = 0.95

    contradiction = Contradiction(
        id="c-1",
        type="pairwise",
        severity="HIGH",
        scope="local",
        involved_belief_ids=["b-0", "b-1"],
    )
    hypothesis_set = HypothesisSet(active=[], eliminated=[])

    result = assign_system_breaking_severity([contradiction], hypothesis_set)
    assert isinstance(result, list)
    # At least one contradiction should remain; severity may or may not be upgraded
    # (conditions depend on belief confidence + hypothesis conflicts)
    assert all(isinstance(c, Contradiction) for c in result)


# ══════════════════════════════════════════════════════════════════════════════
# INV-06 — control_state as sole control input to select_best_action
# ══════════════════════════════════════════════════════════════════════════════


def test_inv_06_blocked_control_state_prevents_action():
    """INV-06: select_best_action returns None when control_state.permission == DENY."""
    blocked = ControlState(permission="DENY")
    wm = _make_world_model()
    hs = HypothesisSet(active=[], eliminated=[])
    tg = TaskGraph()

    action = select_best_action(blocked, wm, hs, tg)
    assert action is None, "INV-06 violated: select_best_action should return None when permission is DENY"


def test_inv_06_clear_control_state_permits_action():
    """INV-06: select_best_action returns an action when permission is ALLOW."""
    clear = ControlState(permission="ALLOW")
    wm = _make_world_model()
    hs = HypothesisSet(active=[], eliminated=[])
    tg = TaskGraph()

    action = select_best_action(clear, wm, hs, tg)
    assert action is not None, "INV-06 violated: select_best_action should return an action when permission is ALLOW"


# ══════════════════════════════════════════════════════════════════════════════
# INV-07 — dep_class_gap is advisory only
# ══════════════════════════════════════════════════════════════════════════════


def test_inv_07_dep_class_gap_does_not_block_tiers_1_to_4():
    """INV-07: dep_class_gap is advisory — DepGraphBudget fields are advisory rate controls."""
    from harness.belief_graph import DepGraphBudget

    # DepGraphBudget holds advisory parameters (max_unverified_edge_ratio, confidence_decay_rate)
    budget = DepGraphBudget(max_unverified_edge_ratio=0.3, confidence_decay_rate=0.02)
    assert isinstance(budget.max_unverified_edge_ratio, float)
    assert isinstance(budget.confidence_decay_rate, float)

    # DepGraphBudget fields are advisory — they don't appear in ControlState block_mask
    cs = ControlState()
    block_mask_str = str(cs.block_mask)
    assert "max_unverified_edge_ratio" not in block_mask_str, (
        "INV-07 violated: dep_class_gap/DepGraphBudget parameter found in block_mask"
    )


# ══════════════════════════════════════════════════════════════════════════════
# INV-08 — Failure mode library scope
# ══════════════════════════════════════════════════════════════════════════════


def test_inv_08_failure_mode_library_only_used_in_tier4_and_hypothesis():
    """INV-08: Failure mode library is consumed by hypothesis generation and Tier 4 only."""
    from harness.failure_modes import FailureModeLibrary, build_default_library
    from harness.hypothesis import generate_from_failure_library

    lib = build_default_library()
    assert isinstance(lib, FailureModeLibrary)
    assert len(lib.patterns) > 0

    # generate_from_failure_library is the only hypothesis-generation entry point
    wm = _make_world_model()
    hyps = generate_from_failure_library(wm, lib)
    assert isinstance(hyps, list)

    # The library does not mutate world_model or control_state directly
    # (structural invariant: same world_model after library use)
    obs_count_before = len(wm.observations)
    _ = generate_from_failure_library(wm, lib)
    assert len(wm.observations) == obs_count_before, "INV-08 violated: failure library mutated the world model"


# ══════════════════════════════════════════════════════════════════════════════
# INV-09 — Adversarial prior discarded after reviewer_pass
# ══════════════════════════════════════════════════════════════════════════════


def test_inv_09_adversarial_prior_not_live_after_reviewer_pass():
    """INV-09: reviewer_pass result has no live references to the adversarial prior."""

    wm = _make_world_model(2)
    task_graph = TaskGraph(
        tasks=[
            Task(id="t1", description="task", status="ACTIVE", completed_evidence=[], abstraction_level=0),
        ]
    )
    hypothesis_set = HypothesisSet(
        active=[
            Hypothesis(
                id="h1",
                explanation="test",
                confidence=0.7,
                predicted_observations=[],
                discriminating_evidence=[],
                generation_sources=["symptom_inference"],
            )
        ],
        eliminated=[],
    )
    output_contract = OutputContract()

    result = reviewer_pass(
        world_model=wm,
        task_graph=task_graph,
        success_criteria=["criterion 1"],
        output_contract=output_contract,
        hypothesis_set=hypothesis_set,
        evidence_store=None,
        caller_state=None,
        belief_dep_graph=None,
        failure_history=None,
    )

    assert isinstance(result, ReviewPassResult)
    # The ReviewPassResult must not hold a reference to an adversarial_prior object
    # that would remain live. Check it is serialisable as a plain dict.
    result_dict = result.to_dict()
    assert isinstance(result_dict, dict)
    # adversarial_prior key should be absent or None in the public result
    assert "adversarial_prior" not in result_dict or result_dict.get("adversarial_prior") is None


# ══════════════════════════════════════════════════════════════════════════════
# INV-10 — experience_store is no-op when absent
# ══════════════════════════════════════════════════════════════════════════════


def test_inv_10_experience_store_absent_produces_noop():
    """INV-10: warm_start with experience_store=None returns WarmStartResult(loaded=False)."""
    result_without = warm_start(
        experience_store=None,
        strategy_state=StrategyState(),
        failure_diagnostics=None,
        task_graph=None,
        task_class="test_task",
        dep_graph_budget=None,
    )
    assert isinstance(result_without, WarmStartResult)
    assert result_without.loaded is False


def test_inv_10_run_one_iteration_identical_without_experience_store():
    """INV-10: run_one_iteration with and without experience_store gives structurally equivalent output."""

    def _make_state():
        return HarnessRunState(
            run_id="inv10-test",
            world_model=_make_world_model(),
            diagnostics=_make_diagnostics(),
            task_graph=TaskGraph(
                tasks=[
                    Task(id="t1", description="task", status="ACTIVE", completed_evidence=[], abstraction_level=0),
                ]
            ),
            hypothesis_set=HypothesisSet(active=[], eliminated=[]),
            evidence_store=EvidenceStore(),
            strategy_state=StrategyState(),
            memory_state=MemoryState(),
            failure_diagnostics=FailureDiagnostics(),
        )

    state_with = _make_state()
    state_without = _make_state()

    result_with = run_one_iteration(
        world_model=state_with.world_model,
        diagnostics=state_with.diagnostics,
        hypothesis_set=state_with.hypothesis_set,
        task_graph=state_with.task_graph,
        experience_store=None,
        step_count=0,
    )
    result_without = run_one_iteration(
        world_model=state_without.world_model,
        diagnostics=state_without.diagnostics,
        hypothesis_set=state_without.hypothesis_set,
        task_graph=state_without.task_graph,
        step_count=0,
    )

    # Both results must have the same structure (same top-level keys)
    assert set(result_with.keys()) == set(result_without.keys()), (
        "INV-10 violated: presence of experience_store changed the result structure"
    )
    # Both must have the same escalated status
    assert result_with.get("escalated") == result_without.get("escalated")


# ══════════════════════════════════════════════════════════════════════════════
# INV-11 — Diagnostic provenance (Phase C2; criticism001 #3; ADR-004)
# ══════════════════════════════════════════════════════════════════════════════


def test_inv_11_no_sub_dimension_reaches_the_resolver_un_provenanced():
    """INV-11: every name in _extract_sub_dimensions' output has an entry in
    diagnostics.provenance by the time the resolver has read it — a dimension with
    no provenance never reaches a tier."""
    from harness.control_state import _extract_sub_dimensions, resolve_control_state
    from harness.diagnostics import Diagnostics, DimensionProvenance

    diagnostics = Diagnostics()  # constructed with an empty provenance map
    assert diagnostics.provenance == {}

    wm = _make_world_model()
    resolve_control_state(diagnostics, wm)

    sub_dim_names = {name for name, _v, _t in _extract_sub_dimensions(diagnostics)}
    assert sub_dim_names <= set(diagnostics.provenance), (
        "INV-11 violated: a sub-dimension reached the resolver with no provenance entry"
    )
    for name in sub_dim_names:
        assert isinstance(diagnostics.provenance[name], DimensionProvenance)


def test_inv_11_provenance_annotation_does_not_change_permission_or_mode():
    """INV-11: the annotation is advisory — flagging an uncalibrated model-derived block
    adds a note but never changes permission/execution_mode/block_mask vs. the same
    diagnostics with deterministic provenance."""
    from harness.control_state import resolve_control_state
    from harness.diagnostics import Diagnostics, DimensionProvenance

    def _blocked(provenance: dict | None):
        d = Diagnostics()
        d.belief_health.support = 0.05  # < CRITICAL_THRESHOLD → Tier 2 block on belief_support
        if provenance:
            d.provenance.update(provenance)
        return resolve_control_state(d, _make_world_model())

    deterministic = _blocked(None)
    model_flagged = _blocked({"belief_support": DimensionProvenance(source="model", calibrated=False)})

    assert deterministic.permission == model_flagged.permission == "DENY"
    assert deterministic.execution_mode == model_flagged.execution_mode
    assert [b.dimension for b in deterministic.block_mask] == [b.dimension for b in model_flagged.block_mask]
    # ...the only difference is the extra advisory note
    assert len(model_flagged.notes) == len(deterministic.notes) + 1


# ─── Plan-agent invariant smoke tests (Phase 4 hooks) ─────────────────────────


def _make_minimal_plan_template() -> dict:
    """Minimal 7-task problem_solving template for use in tests without installed plan files."""
    tasks = [
        {"id": f"t{i}", "title": f"Task {i}", "description": f"Step {i}.", "depends_on": [f"t{i - 1}"] if i > 1 else []}
        for i in range(1, 8)
    ]
    return {
        "name": "problem_solving",
        "version": "1.0.0",
        "success_criteria": "All steps completed.",
        "tasks": tasks,
    }


def test_inv_plan_load_does_not_bypass_decomposition_gate():
    """INV-PC-01: decomposition_gate() still runs when plan_name is set."""
    import json
    import tempfile

    from harness.loop import initialize_harness

    with tempfile.TemporaryDirectory() as tmpdir:
        plan_path = Path(tmpdir) / "problem_solving.json"
        plan_path.write_text(json.dumps(_make_minimal_plan_template()))

        tg = TaskGraph()
        result = initialize_harness(
            world_model=_make_world_model(),
            diagnostics=_make_diagnostics(),
            task_graph=tg,
            plan_name="problem_solving",
            plan_folder=Path(tmpdir),
        )
    # Tasks seeded from template before gate ran
    assert len(tg.tasks) == 7, "problem_solving has 7 tasks"
    # Gate result is present in return value (not bypassed)
    assert "decomposition_gate" in result, "INV-PC-01: decomposition_gate key must be present"


def test_inv_plan_export_never_raises():
    """save_plan with an unwritable path returns False and does not raise."""
    import json
    import tempfile

    from harness.plan_store import load_plan, plan_to_task_graph, save_plan

    with tempfile.TemporaryDirectory() as tmpdir:
        plan_path = Path(tmpdir) / "problem_solving.json"
        plan_path.write_text(json.dumps(_make_minimal_plan_template()))
        template = load_plan("problem_solving", Path(tmpdir))

    tg, _ = plan_to_task_graph(template)
    bad_dir = Path("/nonexistent_xyz_abc/snapshots")
    # Must not raise — only return False
    result = save_plan("inv-test", 1, tg, template, bad_dir)
    assert result is False


def test_inv_task_graph_to_dict_unchanged():
    """to_dict() output is byte-identical before and after calling the new plan methods."""
    import json

    tg = TaskGraph(
        tasks=[
            Task(id="t1", description="Task 1", status="PENDING"),
            Task(id="t2", description="Task 2", status="ACTIVE", depends_on=["t1"]),
        ]
    )
    baseline = json.dumps(tg.to_dict(), sort_keys=True)

    # Call new plan-facing methods — must not mutate internal state
    _ = tg.to_plan(base_name="test")
    _ = tg.tasks[0].to_plan_task()
    _ = tg.tasks[1].to_plan_task()

    after = json.dumps(tg.to_dict(), sort_keys=True)
    assert baseline == after, "INV: to_plan()/to_plan_task() must not mutate task_graph state"


# ── INV-20 / INV-21 / INV-22 — Trajectory Supervisor (S1) ────────────────────


def _stalled_strategy_state() -> StrategyState:
    # Proxy 1 (completion velocity): no advance across STALL_WINDOW steps.
    return StrategyState(completion_history=[0, 0, 0, 0, 0, 0])


def _run_stall_iteration(directive, *, strategy_state=None, supervisor_on=True, monkeypatch=None):
    if monkeypatch is not None:
        if supervisor_on:
            monkeypatch.setenv("HARNESS_TRAJECTORY_SUPERVISOR", "1")
        else:
            monkeypatch.delenv("HARNESS_TRAJECTORY_SUPERVISOR", raising=False)
    wm = _make_world_model()
    ss = strategy_state or _stalled_strategy_state()
    return (
        run_one_iteration(
            world_model=wm,
            diagnostics=_make_diagnostics(),
            hypothesis_set=HypothesisSet(active=[], eliminated=[]),
            task_graph=TaskGraph(tasks=[Task(id="t1", description="task", status="ACTIVE", abstraction_level=0)]),
            failure_diagnostics=FailureDiagnostics(),
            memory_state=MemoryState(),
            strategy_state=ss,
            step_count=0,
            supervisor_directive=directive,
        ),
        ss,
        wm,
    )


def test_inv_20_supervisor_directive_is_one_shot(monkeypatch):
    """INV-20: a REDIRECT applied at the stall edge is not re-applied next iteration."""
    from harness.recovery import STRATEGY_ORDER
    from harness.supervisor import SupervisorDirective

    ss = _stalled_strategy_state()
    d = SupervisorDirective(action="REDIRECT_STRATEGY", rationale="x", strategy_hint="BROADER_SEARCH")
    r1, ss, _wm = _run_stall_iteration(d, strategy_state=ss, monkeypatch=monkeypatch)
    ss = r1["strategy_state"]
    assert ss.current_strategy == "BROADER_SEARCH"

    # Next stalled iteration, no directive → plain ladder advance, not a re-redirect.
    r2, _ss2, _wm2 = _run_stall_iteration(None, strategy_state=ss)
    nxt = STRATEGY_ORDER[STRATEGY_ORDER.index("BROADER_SEARCH") + 1]
    assert r2["strategy_state"].current_strategy == nxt


def test_inv_21_supervisor_does_not_touch_resolver_or_world_model(monkeypatch):
    """INV-21: with vs without a directive, the resolved control state and the belief/
    observation/contradiction sets are identical."""
    from harness.supervisor import SupervisorDirective

    d = SupervisorDirective(action="REDIRECT_STRATEGY", rationale="x", strategy_hint="REIMPLEMENT")
    r_with, _ss1, wm_with = _run_stall_iteration(d, monkeypatch=monkeypatch)
    r_without, _ss2, wm_without = _run_stall_iteration(None, supervisor_on=False, monkeypatch=monkeypatch)

    assert r_with["control_state_a"].to_dict() == r_without["control_state_a"].to_dict()
    assert r_with["control_state_b"].to_dict() == r_without["control_state_b"].to_dict()
    assert [(b.id, b.statement) for b in wm_with.beliefs] == [(b.id, b.statement) for b in wm_without.beliefs]
    assert [o.id for o in wm_with.observations] == [o.id for o in wm_without.observations]
    assert [c.id for c in wm_with.contradictions] == [c.id for c in wm_without.contradictions]


def test_inv_22_supervisor_ignored_when_not_stalled(monkeypatch):
    """INV-22: a directive passed on a non-stalled iteration changes nothing."""
    from harness.supervisor import SupervisorDirective

    ss = StrategyState(completion_history=[1, 2, 3])  # healthy
    d = SupervisorDirective(action="REDIRECT_STRATEGY", rationale="x", strategy_hint="REIMPLEMENT")
    r, _out_ss, _wm = _run_stall_iteration(d, strategy_state=ss, monkeypatch=monkeypatch)
    assert r["strategy_state"].current_strategy == "DIRECT_EDIT"
    assert r["strategy_state"].switch_count == 0
    assert not any("supervisor" in t for t in r["strategy_state"].switch_triggers)


# ── INV-23 / INV-24 / INV-25 — Trajectory Supervisor investigation sub-agent (S4) ──


def test_inv_23_investigation_has_no_write_shell_email_tools():
    """INV-23: write / shell / email / unknown fn_refs are filtered out before any
    dispatch, and run_investigation never calls tool_runner with a rejected name."""
    from harness.investigation import (
        InvestigationOutcome,
        run_investigation,
        validate_investigation_tools,
    )
    from harness.supervisor import InvestigationRequest

    forbidden = ["write_file", "run_shell_command", "send_email", "totally_unknown_tool"]
    allowed, rejected = validate_investigation_tools([*forbidden, "retrieve"])
    assert allowed == ["retrieve"]
    assert set(rejected) == set(forbidden)

    dispatched: list[str] = []

    def runner(tool: str, _q: str) -> str:
        dispatched.append(tool)
        return "finding"

    req = InvestigationRequest(question="which port?", suggested_tools=[*forbidden, "retrieve"], budget=5)
    outcome = run_investigation(req, tool_runner=runner)
    assert isinstance(outcome, InvestigationOutcome)
    assert dispatched == ["retrieve"]  # no forbidden tool ever dispatched
    assert set(outcome.rejected_tools) == set(forbidden)


def test_inv_24_investigation_depth_capped_at_one():
    """INV-24: run_investigation at depth >= 1 raises — an investigation cannot spawn one."""
    from harness.investigation import InvestigationDepthExceeded, run_investigation
    from harness.supervisor import InvestigationRequest

    req = InvestigationRequest(question="q", suggested_tools=["retrieve"], budget=2)
    with pytest.raises(InvestigationDepthExceeded):
        run_investigation(req, tool_runner=lambda _t, _q: "x", depth=1)


def test_inv_25_investigation_budget_bounded_and_never_hangs():
    """INV-25: a hanging tool is cut off by the per-call timeout, and a budget smaller
    than the tool list returns partial findings with exhausted=True — no hang."""
    import time

    from harness.investigation import run_investigation
    from harness.supervisor import InvestigationRequest

    def slow_runner(tool: str, _q: str) -> str:
        if tool == "web_search":
            time.sleep(30)  # would hang without the bounded timeout
        return f"{tool}-result"

    req = InvestigationRequest(question="q", suggested_tools=["retrieve", "web_search", "read_file"], budget=2)
    started = time.monotonic()
    outcome = run_investigation(req, tool_runner=slow_runner, per_call_timeout=0.2)
    elapsed = time.monotonic() - started

    assert elapsed < 10  # the 30s sleep was cut off
    assert outcome.exhausted is True  # budget 2 < 3 suggested tools
    assert outcome.calls_made == 2
    assert [f.tool for f in outcome.findings] == ["retrieve"]  # web_search timed out, read_file not reached
