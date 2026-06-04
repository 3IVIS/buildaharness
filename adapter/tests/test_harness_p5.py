"""
Phase 5 acceptance tests — Execution, VOI & Verification.

Tests T01–T24 as specified in plan/phase_5_plan.
All tests run without Postgres or Docker infrastructure.

Run: pytest adapter/tests/test_harness_p5.py -v -k "not harness_state_api"
"""

from __future__ import annotations

import sys
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.diagnostics import Diagnostics
from harness.evidence import Evidence, EvidenceStore
from harness.execution import ExecutionResult, action_dep_overlap, execute, select_reversibility_strategy
from harness.hypothesis import Hypothesis, HypothesisSet
from harness.output_contract import OutputContract, contract_shadow_check
from harness.review_gate import (
    DimensionResult,
    ReviewResult,
    check_output_contract,
    check_world_model_consistency,
    review_proposed_change,
)
from harness.risk import (
    RiskFactors,
    classify_module_type,
    compute_change_scope,
    compute_file_centrality,
    estimate_risk,
)
from harness.task_graph import Task, TaskGraph
from harness.tool_manifest import ToolAvailabilityManifest, ToolEntry, build_manifest
from harness.verification import (
    LayerResult,
    VerificationResult,
    verify,
    verify_evidence_sufficiency,
)
from harness.voi import (
    AdequacyResult,
    VOIResult,
    estimate_value_of_information,
    update_verification_strength,
    verification_adequacy_critic,
)
from harness.world_model import Belief, Observation, WorldModel


# ── Helpers ───────────────────────────────────────────────────────────────────


def _task(
    tid: str,
    *,
    description: str = "task",
    file_path: str = "",
    risk_level: str = "LOW",
    status: str = "PENDING",
) -> Task:
    t = Task(
        id=tid,
        description=description,
        risk_level=risk_level,  # type: ignore[arg-type]
        status=status,          # type: ignore[arg-type]
    )
    if file_path:
        # Attach file_path as extra attribute
        object.__setattr__(t, "file_path", file_path) if hasattr(t, "__slots__") else setattr(t, "file_path", file_path)
    return t


def _world_model_with_refs(file_path: str, n_refs: int) -> WorldModel:
    """Create a world model with n_refs observations referencing file_path."""
    wm = WorldModel(generation_id=1)
    for i in range(n_refs):
        wm.observations.append(Observation(
            id=f"obs-{i}",
            content=f"reference to {file_path} in line {i}",
            source="test",
        ))
    return wm


def _belief(bid: str, statement: str, reliability: str = "", confidence: float = 0.9) -> Belief:
    b = Belief(
        id=bid,
        statement=statement,
        confidence=confidence,
        derived_from=["obs-1"],
    )
    # Attach reliability as extra attribute
    setattr(b, "reliability", reliability)
    return b


def _make_manifest(available: list[str], unavailable: list[str] | None = None) -> ToolAvailabilityManifest:
    """Build a manifest with explicit availability settings."""
    manifest = ToolAvailabilityManifest()
    for tool in available:
        manifest._entries[tool] = ToolEntry(tool_name=tool, available=True, fallback_tool=None)
    for tool in (unavailable or []):
        manifest._entries[tool] = ToolEntry(tool_name=tool, available=False, fallback_tool=None)
    manifest._freeze()
    return manifest


def _make_all_unavailable_manifest() -> ToolAvailabilityManifest:
    """Build a manifest with all verification tools unavailable."""
    all_tools = [
        "linter", "pytest", "integration_runner", "consistency_checker",
        "requirements_checker", "assumption_checker", "goal_checker",
        "evidence_checker", "contract_checker",
    ]
    return _make_manifest(available=[], unavailable=all_tools)


def _make_evidence_store(n_high: int = 0, n_medium: int = 0, n_low: int = 0) -> EvidenceStore:
    store = EvidenceStore()
    for i in range(n_high):
        store.append(Evidence(
            id=f"h-{i}", obs=f"high obs {i}", reliability="HIGH",
            source="test", evidence_type="OBSERVATION", freshness=1.0,
        ))
    for i in range(n_medium):
        store.append(Evidence(
            id=f"m-{i}", obs=f"medium obs {i}", reliability="MEDIUM",
            source="test", evidence_type="OBSERVATION", freshness=1.0,
        ))
    for i in range(n_low):
        store.append(Evidence(
            id=f"l-{i}", obs=f"low obs {i}", reliability="LOW",
            source="test", evidence_type="OBSERVATION", freshness=0.5,
        ))
    return store


# ══════════════════════════════════════════════════════════════════════════════
# T01  Risk estimation — core vs test file
# ══════════════════════════════════════════════════════════════════════════════


def test_T01_risk_core_biz_high_refs_is_high():
    """T01a — core biz logic file with many refs → HIGH risk.

    With 50 refs: centrality=1.0; module_score=1.0 (core file);
    score = 0.4*1.0 + 0.3*scope + 0.3*1.0 >= 0.7 → HIGH.
    """
    file_path = "adapter/harness/core_engine.py"
    wm = _world_model_with_refs(file_path, 50)  # 50 refs → centrality = 1.0

    task = _task("t1", file_path=file_path, description="refactor core_engine.py")
    level = estimate_risk(task, wm)

    assert level == "HIGH", f"Expected HIGH risk but got {level}"


def test_T01_risk_test_file_2_refs_is_low():
    """T01b — test-only file with 2 refs → LOW risk."""
    file_path = "adapter/tests/test_foo.py"
    wm = _world_model_with_refs(file_path, 2)

    task = _task("t2", file_path=file_path, description="add test")
    level = estimate_risk(task, wm)

    assert level == "LOW", f"Expected LOW risk but got {level}"


# ══════════════════════════════════════════════════════════════════════════════
# T02  estimate_risk updates task.risk_level in place
# ══════════════════════════════════════════════════════════════════════════════


def test_T02_estimate_risk_updates_task_risk_level():
    """T02 — estimate_risk sets task.risk_level as side effect."""
    file_path = "adapter/harness/core_engine.py"
    wm = _world_model_with_refs(file_path, 50)  # 50 refs → centrality = 1.0 → HIGH
    task = _task("t3", file_path=file_path, description="refactor core_engine.py")

    assert task.risk_level == "LOW"  # default
    level = estimate_risk(task, wm)
    assert task.risk_level == level  # side effect occurred
    assert task.risk_level == "HIGH"


# ══════════════════════════════════════════════════════════════════════════════
# T03  HIGH risk task → requires_adversarial_pass=True in adequacy result
# ══════════════════════════════════════════════════════════════════════════════


def test_T03_high_risk_triggers_adversarial_pass():
    """T03 — HIGH risk task → AdequacyResult.requires_adversarial_pass=True."""
    manifest = _make_manifest(available=["linter", "pytest", "integration_runner"])
    result = verification_adequacy_critic(manifest, "HIGH", evidence_store=None)
    assert result.requires_adversarial_pass is True


def test_T03_low_risk_no_adversarial_pass():
    """T03b — LOW risk task → requires_adversarial_pass=False."""
    manifest = _make_manifest(available=["linter", "pytest", "integration_runner"])
    result = verification_adequacy_critic(manifest, "LOW", evidence_store=None)
    assert result.requires_adversarial_pass is False


# ══════════════════════════════════════════════════════════════════════════════
# T04  Low explanation_coverage + HIGH risk → should_gather=True
# ══════════════════════════════════════════════════════════════════════════════


def test_T04_low_explanation_coverage_high_risk_should_gather():
    """T04 — low explanation_coverage + HIGH risk → should_gather=True."""
    diagnostics = Diagnostics()
    diagnostics.coverage_health.explanation_coverage = 0.1  # low coverage → high uncertainty

    task = _task("t4", risk_level="HIGH")

    result = estimate_value_of_information(
        evidence_store=None,
        world_model=WorldModel(),
        current_task=task,
        diagnostics=diagnostics,
    )

    # uncertainty_reduction = 1 - 0.1 = 0.9; decision_impact = 1.0 (HIGH)
    # voi_score = 0.9 * 1.0 = 0.9 > 0.3 threshold
    assert result.should_gather is True
    assert result.voi_score > 0.3


def test_T04_high_explanation_coverage_low_risk_no_gather():
    """T04b — high explanation_coverage + LOW risk → should_gather=False."""
    diagnostics = Diagnostics()
    diagnostics.coverage_health.explanation_coverage = 0.95  # high coverage → low uncertainty

    task = _task("t5", risk_level="LOW")

    result = estimate_value_of_information(
        evidence_store=None,
        world_model=WorldModel(),
        current_task=task,
        diagnostics=diagnostics,
    )

    # uncertainty_reduction = 1 - 0.95 = 0.05; decision_impact = 0.3 (LOW)
    # voi_score = 0.05 * 0.3 = 0.015 <= 0.3 threshold
    assert result.should_gather is False


# ══════════════════════════════════════════════════════════════════════════════
# T05  < 3 available layers → adequate=False, resolution=gather_evidence
# ══════════════════════════════════════════════════════════════════════════════


def test_T05_fewer_than_3_layers_gather_evidence():
    """T05 — exactly 2 available layers → adequate=False, resolution='gather_evidence'."""
    # Provide exactly 2 tools that map to layers
    manifest = _make_manifest(
        available=["linter", "pytest"],
        unavailable=[
            "integration_runner", "consistency_checker", "requirements_checker",
            "assumption_checker", "goal_checker", "evidence_checker", "contract_checker",
        ],
    )
    result = verification_adequacy_critic(manifest, "LOW", evidence_store=None)

    assert result.adequate is False
    assert result.resolution == "gather_evidence"
    assert len(result.available_layers) == 2


# ══════════════════════════════════════════════════════════════════════════════
# T06  < 2 layers → resolution=escalate, strength updated, no loop
# ══════════════════════════════════════════════════════════════════════════════


def test_T06_fewer_than_2_layers_escalate():
    """T06 — exactly 1 available layer → adequate=False, resolution='escalate'."""
    manifest = _make_manifest(
        available=["linter"],
        unavailable=[
            "pytest", "integration_runner", "consistency_checker", "requirements_checker",
            "assumption_checker", "goal_checker", "evidence_checker", "contract_checker",
        ],
    )
    result = verification_adequacy_critic(manifest, "LOW", evidence_store=None)

    assert result.adequate is False
    assert result.resolution == "escalate"
    assert len(result.available_layers) == 1


def test_T06_update_verification_strength_with_1_layer():
    """T06b — update_verification_strength sets strength proportionally."""
    diagnostics = Diagnostics()
    diagnostics.verification_health.strength = 1.0

    update_verification_strength(diagnostics, 1)

    # 1 layer / 9 total ≈ 0.111
    expected = 1 / 9
    assert abs(diagnostics.verification_health.strength - expected) < 0.01


def test_T06_no_loop_on_escalate():
    """T06c — escalate path does not loop — returns immediately."""
    manifest = _make_manifest(
        available=[],  # zero layers
        unavailable=[
            "linter", "pytest", "integration_runner", "consistency_checker",
            "requirements_checker", "assumption_checker", "goal_checker",
            "evidence_checker", "contract_checker",
        ],
    )
    # This call must complete without looping/hanging
    result = verification_adequacy_critic(manifest, "MEDIUM", evidence_store=None)
    assert result.resolution == "escalate"
    assert result.adequate is False


# ══════════════════════════════════════════════════════════════════════════════
# T07  Change contradicting HIGH-reliability belief fails dimension 2
# ══════════════════════════════════════════════════════════════════════════════


def test_T07_contradicts_high_reliability_belief_fails():
    """T07 — proposed change that negates a HIGH-reliability belief fails consistency."""
    wm = WorldModel()
    high_belief = _belief("b1", "caching is enabled", reliability="HIGH")
    wm.beliefs.append(high_belief)

    proposed_change = {"description": "removes caching is enabled in the module"}

    result = check_world_model_consistency(proposed_change, wm)

    assert result.passed is False
    assert "HIGH-reliability" in result.reason


def test_T07_low_reliability_belief_no_failure():
    """T07b — negating a LOW-reliability belief does not fail consistency."""
    wm = WorldModel()
    low_belief = _belief("b2", "caching is optional", reliability="LOW")
    wm.beliefs.append(low_belief)

    proposed_change = {"description": "removes caching is optional"}

    result = check_world_model_consistency(proposed_change, wm)

    assert result.passed is True


# ══════════════════════════════════════════════════════════════════════════════
# T08  Change removing required_interface_field fails dimension 3
# ══════════════════════════════════════════════════════════════════════════════


def test_T08_removes_required_field_fails_contract_check():
    """T08 — change removing a required_interface_field fails output contract check."""
    contract = OutputContract(required_interface_fields=["user_id", "session_token"])

    proposed_change = {"description": "remove user_id from the response payload"}

    result = check_output_contract(proposed_change, contract)

    assert result.passed is False
    assert "user_id" in result.reason


def test_T08_no_removal_passes_contract_check():
    """T08b — change not removing required fields passes."""
    contract = OutputContract(required_interface_fields=["user_id"])
    proposed_change = {"description": "add extra metadata to the response"}

    result = check_output_contract(proposed_change, contract)

    assert result.passed is True


# ══════════════════════════════════════════════════════════════════════════════
# T09  Two consecutive failures → escalation_triggered=True
# ══════════════════════════════════════════════════════════════════════════════


def test_T09_two_consecutive_failures_escalation():
    """T09 — two consecutive review failures on same task → escalation_triggered=True."""
    wm = WorldModel()
    high_belief = _belief("b1", "auth is required", reliability="HIGH")
    wm.beliefs.append(high_belief)

    # Change that contradicts a HIGH-reliability belief → fails consistency dim
    bad_change = {"description": "removes auth is required from the API"}
    task = _task("task-9", description="update API")

    failures_map: dict[str, int] = {}

    # First failure
    result1 = review_proposed_change(
        proposed_change=bad_change,
        current_task=task,
        world_model=wm,
        output_contract=None,
        hypothesis_set=None,
        tool_manifest=None,
        consecutive_failures_map=failures_map,
    )
    assert result1.passed is False
    assert result1.consecutive_failures == 1
    assert result1.escalation_triggered is False

    # Second failure (same task)
    result2 = review_proposed_change(
        proposed_change=bad_change,
        current_task=task,
        world_model=wm,
        output_contract=None,
        hypothesis_set=None,
        tool_manifest=None,
        consecutive_failures_map=failures_map,
    )
    assert result2.passed is False
    assert result2.consecutive_failures == 2
    assert result2.escalation_triggered is True


def test_T09_success_resets_consecutive_count():
    """T09b — successful review resets consecutive failure count."""
    failures_map: dict[str, int] = {"task-9b": 2}
    task = _task("task-9b", description="simple change")

    result = review_proposed_change(
        proposed_change={"description": "add logging"},
        current_task=task,
        world_model=None,
        output_contract=None,
        hypothesis_set=None,
        tool_manifest=None,
        consecutive_failures_map=failures_map,
    )

    assert result.passed is True
    assert failures_map.get("task-9b", 0) == 0
    assert result.consecutive_failures == 0
    assert result.escalation_triggered is False


# ══════════════════════════════════════════════════════════════════════════════
# T10  Tool error → SYSTEM_ERROR Evidence, reliability=HIGH, in observations
# ══════════════════════════════════════════════════════════════════════════════


def test_T10_tool_error_creates_system_error_evidence():
    """T10 — failing tool_workflow creates SYSTEM_ERROR Evidence(reliability=HIGH)."""
    def failing_workflow():
        raise RuntimeError("tool failed")

    wm = WorldModel()
    task = _task("t10", risk_level="LOW")
    tg = TaskGraph(tasks=[task])
    evidence_store = EvidenceStore()

    result = execute(
        proposed_change={"change_type": "file_mutation", "description": "edit"},
        tool_workflow=failing_workflow,
        world_model=wm,
        task_graph=tg,
        current_task=task,
        evidence_store=evidence_store,
    )

    assert result.success is False
    assert result.error is not None

    # SYSTEM_ERROR evidence must be in the store
    sys_errors = [e for e in evidence_store.entries if e.evidence_type == "SYSTEM_ERROR"]
    assert len(sys_errors) >= 1
    assert sys_errors[0].reliability == "HIGH"


def test_T10_tool_error_adds_to_observations_not_beliefs():
    """T10b — error evidence goes to observations list, not beliefs."""
    def failing_workflow():
        raise RuntimeError("tool failed")

    wm = WorldModel()
    task = _task("t10b", risk_level="LOW")
    tg = TaskGraph(tasks=[task])
    evidence_store = EvidenceStore()

    execute(
        proposed_change={"change_type": "file_mutation"},
        tool_workflow=failing_workflow,
        world_model=wm,
        task_graph=tg,
        current_task=task,
        evidence_store=evidence_store,
    )

    # Observation added for error
    assert len(wm.observations) >= 1
    assert any("SYSTEM_ERROR" in o.content or "error" in o.content.lower() for o in wm.observations)
    # No beliefs added (beliefs require derivation chains that errors don't have)
    assert len(wm.beliefs) == 0


# ══════════════════════════════════════════════════════════════════════════════
# T11  Successful execution records in environment_change_log
# ══════════════════════════════════════════════════════════════════════════════


def test_T11_successful_execution_records_change_log():
    """T11 — successful execution records entry in world_model.environment_change_log."""
    def ok_workflow():
        return {"status": "done"}

    wm = WorldModel()
    task = _task("t11", risk_level="LOW")
    tg = TaskGraph(tasks=[task])
    evidence_store = EvidenceStore()

    result = execute(
        proposed_change={"change_type": "file_mutation"},
        tool_workflow=ok_workflow,
        world_model=wm,
        task_graph=tg,
        current_task=task,
        evidence_store=evidence_store,
    )

    assert result.success is True
    assert len(wm.environment_change_log) == 1
    log_entry = wm.environment_change_log[0]
    assert log_entry.get("status") == "completed"
    assert log_entry.get("task_id") == "t11"


# ══════════════════════════════════════════════════════════════════════════════
# T12  Read-only change → "ephemeral" strategy, no rollback_ref
# ══════════════════════════════════════════════════════════════════════════════


def test_T12_read_only_change_ephemeral_strategy():
    """T12 — read-only change → strategy='ephemeral', rollback_ref=None."""
    proposed_change = {"change_type": "read-only", "description": "read file"}

    strategy = select_reversibility_strategy(proposed_change, "HIGH")
    assert strategy == "ephemeral"

    def read_workflow():
        return "read result"

    task = _task("t12", risk_level="HIGH")
    tg = TaskGraph(tasks=[task])
    wm = WorldModel()
    evidence_store = EvidenceStore()

    result = execute(
        proposed_change=proposed_change,
        tool_workflow=read_workflow,
        world_model=wm,
        task_graph=tg,
        current_task=task,
        evidence_store=evidence_store,
    )

    assert result.strategy == "ephemeral"
    assert result.rollback_ref is None


# ══════════════════════════════════════════════════════════════════════════════
# T13  File mutation + HIGH risk + git repo → "git-revert"
# ══════════════════════════════════════════════════════════════════════════════


def test_T13_file_mutation_high_risk_git_repo():
    """T13 — file mutation + HIGH risk in git repo → 'git-revert' strategy."""
    import os
    import tempfile
    import subprocess

    # Create a temp directory with a .git dir to simulate a git repo
    with tempfile.TemporaryDirectory() as tmpdir:
        os.makedirs(os.path.join(tmpdir, ".git"))
        old_cwd = os.getcwd()
        os.chdir(tmpdir)
        try:
            proposed_change = {"change_type": "file_mutation"}
            strategy = select_reversibility_strategy(proposed_change, "HIGH")
            assert strategy == "git-revert"
        finally:
            os.chdir(old_cwd)


def test_T13_file_mutation_high_risk_no_git():
    """T13b — file mutation + HIGH risk without git → 'snapshot' strategy."""
    import os
    import tempfile

    with tempfile.TemporaryDirectory() as tmpdir:
        # No .git directory
        old_cwd = os.getcwd()
        os.chdir(tmpdir)
        try:
            proposed_change = {"change_type": "file_mutation"}
            strategy = select_reversibility_strategy(proposed_change, "HIGH")
            assert strategy == "snapshot"
        finally:
            os.chdir(old_cwd)


def test_T13_file_mutation_low_risk_patch_rollback():
    """T13c — file mutation + LOW risk → 'patch-rollback' strategy."""
    proposed_change = {"change_type": "file_mutation"}
    strategy = select_reversibility_strategy(proposed_change, "LOW")
    assert strategy == "patch-rollback"


# ══════════════════════════════════════════════════════════════════════════════
# T14  Task status transitions during execution
# ══════════════════════════════════════════════════════════════════════════════


def test_T14_task_transitions_to_verifying_on_success():
    """T14 — successful execution transitions task PENDING→ACTIVE→VERIFYING."""
    task = _task("t14", risk_level="LOW")
    tg = TaskGraph(tasks=[task])
    wm = WorldModel()

    assert task.status == "PENDING"

    execute(
        proposed_change={"change_type": "file_mutation"},
        tool_workflow=lambda: "ok",
        world_model=wm,
        task_graph=tg,
        current_task=task,
        evidence_store=EvidenceStore(),
    )

    assert task.status == "VERIFYING"


def test_T14_task_transitions_to_failed_on_error():
    """T14b — failed execution transitions task PENDING→ACTIVE→FAILED."""
    task = _task("t14b", risk_level="LOW")
    tg = TaskGraph(tasks=[task])
    wm = WorldModel()

    def fail():
        raise RuntimeError("oops")

    execute(
        proposed_change={"change_type": "file_mutation"},
        tool_workflow=fail,
        world_model=wm,
        task_graph=tg,
        current_task=task,
        evidence_store=EvidenceStore(),
    )

    assert task.status == "FAILED"


# ══════════════════════════════════════════════════════════════════════════════
# T15  All 9 layers available; unavailable → SKIPPED not FAILED
# ══════════════════════════════════════════════════════════════════════════════


def test_T15_all_9_layers_present_when_all_tools_available():
    """T15 — all 9 verification layers run when all tools available."""
    # Build manifest with all tools available
    all_tools = [
        "linter", "pytest", "integration_runner", "consistency_checker",
        "requirements_checker", "assumption_checker", "goal_checker",
        "evidence_checker", "contract_checker",
    ]
    manifest = _make_manifest(available=all_tools)

    # Use enough evidence so evidence_sufficiency passes (local: >= 2)
    evidence_store = _make_evidence_store(n_high=2)

    vr = verify(
        result={"key": "value"},
        success_criteria=["done"],
        assumptions=["stable"],
        tool_manifest=manifest,
        task_risk="LOW",
        evidence_store=evidence_store,
        world_model=WorldModel(),
        output_contract=OutputContract(),
    )

    layer_names = [lr.layer for lr in vr.layer_results]
    assert len(vr.layer_results) == 9
    for expected_layer in [
        "syntax", "unit", "integration", "consistency", "requirements",
        "assumptions", "goal_correctness", "evidence_sufficiency", "output_contract_partial",
    ]:
        assert expected_layer in layer_names


def test_T15_unavailable_tool_gives_skipped_not_failed():
    """T15b — unavailable tool → layer status is SKIPPED, not FAILED."""
    # Make only linter unavailable
    manifest = _make_manifest(
        available=[
            "pytest", "integration_runner", "consistency_checker", "requirements_checker",
            "assumption_checker", "goal_checker", "evidence_checker", "contract_checker",
        ],
        unavailable=["linter"],
    )
    evidence_store = _make_evidence_store(n_high=2)

    vr = verify(
        result={"key": "value"},
        success_criteria=[],
        assumptions=[],
        tool_manifest=manifest,
        task_risk="LOW",
        evidence_store=evidence_store,
    )

    syntax_results = [lr for lr in vr.layer_results if lr.layer == "syntax"]
    assert len(syntax_results) == 1
    assert syntax_results[0].status == "SKIPPED"
    # No critical failure just from a skip
    assert vr.has_critical_failure is False


# ══════════════════════════════════════════════════════════════════════════════
# T16  Evidence sufficiency — global >= 5, local >= 2
# ══════════════════════════════════════════════════════════════════════════════


def test_T16_global_scope_needs_5_evidence():
    """T16a — global scope with only 4 HIGH/MEDIUM items → FAIL."""
    manifest = _make_manifest(available=["evidence_checker"])
    store = _make_evidence_store(n_high=3, n_medium=1)  # 4 qualifying, need 5

    lr = verify_evidence_sufficiency(
        result={},
        evidence_store=store,
        tool_manifest=manifest,
        scope="global",
    )

    assert lr.status == "FAIL"
    assert "5" in lr.detail or "Global" in lr.detail


def test_T16_global_scope_with_5_evidence_passes():
    """T16b — global scope with 5 HIGH/MEDIUM items → PASS."""
    manifest = _make_manifest(available=["evidence_checker"])
    store = _make_evidence_store(n_high=3, n_medium=2)  # 5 qualifying

    lr = verify_evidence_sufficiency(
        result={},
        evidence_store=store,
        tool_manifest=manifest,
        scope="global",
    )

    assert lr.status == "PASS"


def test_T16_local_scope_needs_2_evidence():
    """T16c — local scope with only 1 item → FAIL."""
    manifest = _make_manifest(available=["evidence_checker"])
    store = _make_evidence_store(n_high=1)

    lr = verify_evidence_sufficiency(
        result={},
        evidence_store=store,
        tool_manifest=manifest,
        scope="local",
    )

    assert lr.status == "FAIL"


def test_T16_local_scope_with_2_evidence_passes():
    """T16d — local scope with 2 items → PASS."""
    manifest = _make_manifest(available=["evidence_checker"])
    store = _make_evidence_store(n_high=2)

    lr = verify_evidence_sufficiency(
        result={},
        evidence_store=store,
        tool_manifest=manifest,
        scope="local",
    )

    assert lr.status == "PASS"


# ══════════════════════════════════════════════════════════════════════════════
# T17  HIGH risk → adversarial_passed field non-None
# ══════════════════════════════════════════════════════════════════════════════


def test_T17_high_risk_sets_adversarial_passed():
    """T17 — HIGH risk task → adversarial_passed is not None in VerificationResult."""
    manifest = _make_manifest(
        available=["linter", "pytest", "integration_runner", "evidence_checker"],
        unavailable=[
            "consistency_checker", "requirements_checker", "assumption_checker",
            "goal_checker", "contract_checker",
        ],
    )
    evidence_store = _make_evidence_store(n_high=2)

    vr = verify(
        result={"output": "ok"},
        success_criteria=[],
        assumptions=[],
        tool_manifest=manifest,
        task_risk="HIGH",
        evidence_store=evidence_store,
    )

    assert vr.adversarial_passed is not None


def test_T17_low_risk_adversarial_passed_is_none():
    """T17b — LOW risk task → adversarial_passed is None."""
    manifest = _make_all_unavailable_manifest()
    evidence_store = EvidenceStore()

    vr = verify(
        result={"output": "ok"},
        success_criteria=[],
        assumptions=[],
        tool_manifest=manifest,
        task_risk="LOW",
        evidence_store=evidence_store,
    )

    assert vr.adversarial_passed is None


# ══════════════════════════════════════════════════════════════════════════════
# T18  SKIPPED layers don't reduce strength beyond adequacy critic
# ══════════════════════════════════════════════════════════════════════════════


def test_T18_skipped_layers_do_not_cause_critical_failure():
    """T18 — SKIPPED layers don't set has_critical_failure=True."""
    # All tools unavailable → all layers skipped
    manifest = _make_all_unavailable_manifest()

    vr = verify(
        result={"output": "ok"},
        success_criteria=[],
        assumptions=[],
        tool_manifest=manifest,
        task_risk="LOW",
        evidence_store=EvidenceStore(),
    )

    # All layers skipped
    assert all(lr.status == "SKIPPED" for lr in vr.layer_results)
    assert vr.has_critical_failure is False


def test_T18_skipped_layers_strength_from_adequacy_critic():
    """T18b — update_verification_strength properly reflects available count."""
    diagnostics = Diagnostics()
    update_verification_strength(diagnostics, 0)
    assert diagnostics.verification_health.strength == 0.0

    update_verification_strength(diagnostics, 9)
    assert diagnostics.verification_health.strength == 1.0

    update_verification_strength(diagnostics, 5)
    expected = 5 / 9
    assert abs(diagnostics.verification_health.strength - expected) < 0.01


# ══════════════════════════════════════════════════════════════════════════════
# T19  Missing required_interface_field caught by shadow check, is_stub=False
# ══════════════════════════════════════════════════════════════════════════════


def test_T19_missing_required_field_caught_by_shadow_check():
    """T19 — contract_shadow_check catches missing required_interface_field."""
    contract = OutputContract(required_interface_fields=["status", "data"])
    result_dict = {"status": "ok"}  # missing "data"

    check = contract_shadow_check(result_dict, contract)

    assert check.passed is False
    assert check.is_stub is False
    assert any("data" in v for v in check.violations)


def test_T19_shadow_check_is_not_stub():
    """T19b — contract_shadow_check returns is_stub=False."""
    check = contract_shadow_check({}, OutputContract())
    assert check.is_stub is False


# ══════════════════════════════════════════════════════════════════════════════
# T20  Type regression caught by shadow check
# ══════════════════════════════════════════════════════════════════════════════


def test_T20_type_regression_caught():
    """T20 — type mismatch in interface_constraints is caught."""
    contract = OutputContract(
        required_interface_fields=["count"],
        interface_constraints={"count": "int"},
    )
    result_dict = {"count": "not-an-int"}  # string instead of int

    check = contract_shadow_check(result_dict, contract)

    assert check.passed is False
    assert check.is_stub is False
    assert any("count" in v for v in check.violations)


# ══════════════════════════════════════════════════════════════════════════════
# T21  No interface changes → passed=True, is_stub=False
# ══════════════════════════════════════════════════════════════════════════════


def test_T21_no_interface_changes_passes():
    """T21 — result with all required fields passes shadow check."""
    contract = OutputContract(
        required_interface_fields=["user_id", "token"],
        interface_constraints={"user_id": "str", "token": "str"},
    )
    result_dict = {"user_id": "abc123", "token": "tok456", "extra": "ignored"}

    check = contract_shadow_check(result_dict, contract)

    assert check.passed is True
    assert check.is_stub is False
    assert check.violations == []


# ══════════════════════════════════════════════════════════════════════════════
# T22  Overlap + HIGH risk → escalation
# ══════════════════════════════════════════════════════════════════════════════


def test_T22_dep_overlap_high_risk():
    """T22 — action with overlapping compressed structures is detected."""
    action = {
        "required_state_structures": ["world_model_beliefs", "hypothesis_cache"],
        "description": "update beliefs",
    }
    memory_state = {
        "compressed_structures": ["world_model_beliefs"],
        "pruned_regions": [],
    }

    overlaps = action_dep_overlap(action, memory_state)

    assert "world_model_beliefs" in overlaps


def test_T22_pruned_regions_detected():
    """T22b — action with structures in pruned_regions is detected."""
    action = {
        "required_state_structures": ["evidence_cache", "belief_graph"],
        "description": "rebuild evidence",
    }
    memory_state = {
        "compressed_structures": [],
        "pruned_regions": ["evidence_cache"],
    }

    overlaps = action_dep_overlap(action, memory_state)

    assert "evidence_cache" in overlaps
    assert "belief_graph" not in overlaps


# ══════════════════════════════════════════════════════════════════════════════
# T23  Overlap + LOW risk → warning only, no escalation
# ══════════════════════════════════════════════════════════════════════════════


def test_T23_low_risk_overlap_returns_list_not_exception():
    """T23 — overlap with LOW risk returns overlap list (no exception/escalation)."""
    action = {
        "required_state_structures": ["some_structure"],
        "description": "modify",
    }
    memory_state = {
        "compressed_structures": ["some_structure"],
        "pruned_regions": [],
    }

    # Should return overlaps without raising
    overlaps = action_dep_overlap(action, memory_state)
    assert isinstance(overlaps, list)
    assert "some_structure" in overlaps


# ══════════════════════════════════════════════════════════════════════════════
# T24  No overlap → proceeds
# ══════════════════════════════════════════════════════════════════════════════


def test_T24_no_overlap_empty_list():
    """T24 — action with no overlapping structures returns empty list."""
    action = {
        "required_state_structures": ["independent_structure"],
        "description": "safe change",
    }
    memory_state = {
        "compressed_structures": ["world_model_beliefs"],
        "pruned_regions": ["evidence_cache"],
    }

    overlaps = action_dep_overlap(action, memory_state)

    assert overlaps == []


def test_T24_none_memory_state_empty_list():
    """T24b — None memory_state returns empty list (safe path)."""
    action = {
        "required_state_structures": ["world_model_beliefs"],
        "description": "update",
    }

    overlaps = action_dep_overlap(action, None)

    assert overlaps == []
