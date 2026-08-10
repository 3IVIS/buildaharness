"""
Tests for verification.py's Phase 2 rewrite
(plans/harness_and_assistant_architecture_remediation_plan.html) — turning 7 stub
"tool available → unconditional PASS" layers into either a real check (syntax/unit via
execution_boundary; consistency via direct world_model inspection) or an honest SKIPPED
(requirements/assumptions/goal_correctness/integration, which need environmental/model-tier
judgment this layer can't provide).

Run with: pytest adapter/tests/test_harness_verification.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.diagnostics import BeliefHealth, CoverageHealth, Diagnostics, ExecutionHealth, VerificationHealth
from harness.evidence import EvidenceStore
from harness.hypothesis import HypothesisSet
from harness.loop import run_one_iteration
from harness.recovery import StrategyState
from harness.task_graph import Task, TaskGraph
from harness.tool_manifest import build_manifest
from harness.verification import (
    ALL_LAYERS,
    LAYER_TIER,
    verify,
    verify_assumptions,
    verify_consistency,
    verify_goal_correctness,
    verify_integration,
    verify_requirements,
    verify_syntax,
    verify_unit,
)
from harness.world_model import Contradiction, WorldModel


def _manifest(*available: str) -> object:
    return build_manifest(runtime_checks={name: (lambda: True) for name in available})


# ── LAYER_TIER completeness ───────────────────────────────────────────────────────


def test_every_layer_has_a_tier_classification():
    assert set(LAYER_TIER.keys()) == set(ALL_LAYERS)
    assert all(tier in ("mechanical", "environmental", "model") for tier in LAYER_TIER.values())


# ── verify_syntax ──────────────────────────────────────────────────────────────────


def test_syntax_skipped_not_passed_when_no_target_path():
    """The core fix: tool available + nothing to check → SKIPPED, never a fake PASS."""
    lr = verify_syntax(result={"ok": True}, tool_manifest=_manifest("linter"))
    assert lr.status == "SKIPPED"
    assert "target_path" in lr.detail


def test_syntax_skipped_when_tool_unavailable_even_with_target_path(tmp_path):
    good = tmp_path / "good.py"
    good.write_text("x = 1\n")
    lr = verify_syntax(result={"ok": True}, tool_manifest=_manifest(), target_path=str(good))
    assert lr.status == "SKIPPED"


def test_syntax_fails_on_none_result_regardless_of_target_path():
    lr = verify_syntax(result=None, tool_manifest=_manifest("linter"))
    assert lr.status == "FAIL"


def test_syntax_real_check_passes_on_clean_file(tmp_path):
    good = tmp_path / "good.py"
    good.write_text("x = 1\n")
    lr = verify_syntax(result={"ok": True}, tool_manifest=_manifest("linter"), target_path=str(good))
    assert lr.status == "PASS"
    assert "ruff" in lr.detail


def test_syntax_real_check_fails_on_a_file_with_a_syntax_error(tmp_path):
    bad = tmp_path / "bad.py"
    bad.write_text("def f(:\n    pass\n")
    lr = verify_syntax(result={"ok": True}, tool_manifest=_manifest("linter"), target_path=str(bad))
    assert lr.status == "FAIL"
    assert lr.detail  # real ruff output, not a generic message


def test_syntax_target_path_outside_workspace_root_fails_not_raises(tmp_path):
    workspace = tmp_path / "workspace"
    outside = tmp_path / "outside"
    workspace.mkdir()
    outside.mkdir()
    sneaky = outside / "sneaky.py"
    sneaky.write_text("x = 1\n")

    lr = verify_syntax(
        result={"ok": True}, tool_manifest=_manifest("linter"), target_path=str(sneaky), workspace_root=str(workspace)
    )
    assert lr.status == "FAIL"
    assert "boundary" in lr.detail.lower()


# ── verify_unit ──────────────────────────────────────────────────────────────────


def test_unit_skipped_not_passed_when_no_target_path():
    lr = verify_unit(result={"ok": True}, tool_manifest=_manifest("pytest"))
    assert lr.status == "SKIPPED"
    assert "target_path" in lr.detail


def test_unit_real_check_passes_on_a_passing_test_file(tmp_path):
    test_file = tmp_path / "test_good.py"
    test_file.write_text("def test_ok():\n    assert True\n")
    lr = verify_unit(result={"ok": True}, tool_manifest=_manifest("pytest"), target_path=str(test_file))
    assert lr.status == "PASS"


def test_unit_real_check_fails_on_a_failing_test_file(tmp_path):
    test_file = tmp_path / "test_bad.py"
    test_file.write_text("def test_fail():\n    assert False\n")
    lr = verify_unit(result={"ok": True}, tool_manifest=_manifest("pytest"), target_path=str(test_file))
    assert lr.status == "FAIL"


# ── verify_integration ─────────────────────────────────────────────────────────────


def test_integration_always_skipped_even_when_tool_reports_available():
    """No real integration_runner exists in execution_boundary's allowlist — faking a
    pass/fail here would just reintroduce the false-confidence bug this rewrite closes."""
    lr = verify_integration(result={"ok": True}, tool_manifest=_manifest("integration_runner"))
    assert lr.status == "SKIPPED"


# ── verify_consistency ─────────────────────────────────────────────────────────────


def test_consistency_skipped_when_no_world_model():
    lr = verify_consistency(result={"ok": True}, world_model=None, tool_manifest=_manifest("consistency_checker"))
    assert lr.status == "SKIPPED"


def test_consistency_passes_with_no_contradictions():
    wm = WorldModel()
    lr = verify_consistency(result={"ok": True}, world_model=wm, tool_manifest=_manifest("consistency_checker"))
    assert lr.status == "PASS"


def test_consistency_fails_with_unresolved_high_contradiction():
    wm = WorldModel()
    wm.add_contradiction(Contradiction(id="c1", type="pairwise", severity="HIGH", scope="local"))
    lr = verify_consistency(result={"ok": True}, world_model=wm, tool_manifest=_manifest("consistency_checker"))
    assert lr.status == "FAIL"
    assert "1" in lr.detail


def test_consistency_fails_with_system_breaking_contradiction():
    wm = WorldModel()
    wm.add_contradiction(Contradiction(id="c1", type="pairwise", severity="SYSTEM_BREAKING", scope="global"))
    lr = verify_consistency(result={"ok": True}, world_model=wm, tool_manifest=_manifest("consistency_checker"))
    assert lr.status == "FAIL"


def test_consistency_passes_with_only_low_severity_contradictions():
    """LOW/MEDIUM contradictions don't fail consistency — only HIGH/SYSTEM_BREAKING do."""
    wm = WorldModel()
    wm.add_contradiction(Contradiction(id="c1", type="pairwise", severity="LOW", scope="local"))
    lr = verify_consistency(result={"ok": True}, world_model=wm, tool_manifest=_manifest("consistency_checker"))
    assert lr.status == "PASS"


# ── verify_requirements / verify_assumptions: honest SKIPPED, not a fake PASS ─────────


def test_requirements_skipped_when_no_criteria():
    lr = verify_requirements(result={"ok": True}, success_criteria=[], tool_manifest=_manifest("requirements_checker"))
    assert lr.status == "SKIPPED"


def test_requirements_fails_when_criteria_present_but_no_result():
    lr = verify_requirements(result=None, success_criteria=["done"], tool_manifest=_manifest("requirements_checker"))
    assert lr.status == "FAIL"


def test_requirements_skipped_not_passed_when_criteria_and_result_both_present():
    """The core fix: this layer cannot mechanically verify semantic satisfaction of
    criteria — it must not claim PASS for something it didn't actually check."""
    lr = verify_requirements(
        result={"ok": True}, success_criteria=["done"], tool_manifest=_manifest("requirements_checker")
    )
    assert lr.status == "SKIPPED"
    assert "model-tier" in lr.detail


def test_assumptions_skipped_when_none_stated():
    lr = verify_assumptions(result={"ok": True}, assumptions=[], tool_manifest=_manifest("assumption_checker"))
    assert lr.status == "SKIPPED"


def test_assumptions_fails_when_stated_but_no_result():
    lr = verify_assumptions(result=None, assumptions=["stable"], tool_manifest=_manifest("assumption_checker"))
    assert lr.status == "FAIL"


def test_assumptions_skipped_not_passed_when_stated_and_result_present():
    lr = verify_assumptions(result={"ok": True}, assumptions=["stable"], tool_manifest=_manifest("assumption_checker"))
    assert lr.status == "SKIPPED"


# ── verify_goal_correctness: always SKIPPED, never a fake PASS ───────────────────────


def test_goal_correctness_always_skipped_even_when_tool_available():
    lr = verify_goal_correctness(result={"ok": True}, tool_manifest=_manifest("goal_checker"))
    assert lr.status == "SKIPPED"
    assert "model-tier" in lr.detail


# ── verify(): end-to-end, target_path is additive and backward-compatible ────────────


def test_verify_without_target_path_matches_pre_phase2_call_shape(tmp_path):
    """Every existing caller (including node_compilers.py's codegen) never passes
    target_path — confirm the call shape still works and produces only SKIPPED/real
    layers, never a fake PASS from syntax/unit."""
    manifest = _manifest("linter", "pytest", "consistency_checker")
    vr = verify(
        result={"ok": True},
        success_criteria=[],
        assumptions=[],
        tool_manifest=manifest,
        task_risk="LOW",
        world_model=WorldModel(),
    )
    by_layer = {lr.layer: lr for lr in vr.layer_results}
    assert by_layer["syntax"].status == "SKIPPED"
    assert by_layer["unit"].status == "SKIPPED"
    assert vr.has_critical_failure is False


def test_verify_with_target_path_runs_real_syntax_and_unit_checks(tmp_path):
    good = tmp_path / "test_good.py"
    good.write_text("def test_ok():\n    assert True\n")
    manifest = _manifest("linter", "pytest")

    vr = verify(
        result={"ok": True},
        success_criteria=[],
        assumptions=[],
        tool_manifest=manifest,
        task_risk="LOW",
        target_path=str(good),
    )
    by_layer = {lr.layer: lr for lr in vr.layer_results}
    assert by_layer["syntax"].status == "PASS"
    assert by_layer["unit"].status == "PASS"
    assert vr.has_critical_failure is False


# ── loop.py's Sub-step B now uses real verify() output, not a hardcoded stub ─────────


def _iteration_inputs():
    wm = WorldModel()
    diagnostics = Diagnostics(
        belief_health=BeliefHealth(freshness=0.8, consistency=0.8, support=0.8),
        coverage_health=CoverageHealth(symptom_coverage=0.8, explanation_coverage=0.8),
        verification_health=VerificationHealth(strength=0.8, feasibility=0.8),
        execution_health=ExecutionHealth(progress_rate=0.8, failure_recurrence=0.2, oscillation_score=0.2),
    )
    task_graph = TaskGraph(
        tasks=[Task(id="t1", description="task", status="ACTIVE", completed_evidence=[], abstraction_level=0)]
    )
    return dict(
        world_model=wm,
        diagnostics=diagnostics,
        hypothesis_set=HypothesisSet(active=[], eliminated=[]),
        task_graph=task_graph,
        strategy_state=StrategyState(),
    )


def test_run_one_iteration_without_tool_manifest_reproduces_the_old_stubs_net_outcome():
    """Every existing caller omits tool_manifest — confirm gate_b still ends up True
    (has_critical_failure False), matching the old hardcoded stub's net effect exactly."""
    result = run_one_iteration(**_iteration_inputs(), evidence_store=EvidenceStore())
    assert result["gate_b"] is True


def test_run_one_iteration_post_exec_gate_actually_reflects_real_verification_failure():
    """The core fix: gate_b is no longer always True regardless of what happened — a real
    verification failure (evidence_sufficiency, which has always had real logic, not a
    stub) now genuinely blocks Sub-step B's gate, proven by flipping only the evidence
    store's contents while holding everything else — including tool_manifest — fixed."""
    from harness.evidence import Evidence

    manifest = build_manifest(runtime_checks={"evidence_checker": lambda: True})

    # Local scope needs >= 2 evidence items — an empty store FAILs evidence_sufficiency,
    # which is the only real (non-SKIPPED) mechanical layer with this manifest, so it
    # alone determines has_critical_failure.
    empty_store_result = run_one_iteration(
        **_iteration_inputs(), evidence_store=EvidenceStore(), tool_manifest=manifest
    )
    assert empty_store_result["gate_b"] is False

    sufficient_store = EvidenceStore()
    sufficient_store.entries.append(
        Evidence(id="e1", obs="a", reliability="HIGH", source="test", evidence_type="OBSERVATION", freshness=1.0)
    )
    sufficient_store.entries.append(
        Evidence(id="e2", obs="b", reliability="HIGH", source="test", evidence_type="OBSERVATION", freshness=1.0)
    )
    sufficient_store_result = run_one_iteration(
        **_iteration_inputs(), evidence_store=sufficient_store, tool_manifest=manifest
    )
    assert sufficient_store_result["gate_b"] is True
