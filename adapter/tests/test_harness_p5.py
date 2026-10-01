"""
Phase 5 acceptance tests — Execution, VOI & Verification.

Tests T01–T24 as specified in plan/phase_5_plan.
All tests run without Postgres or Docker infrastructure.

Run: pytest adapter/tests/test_harness_p5.py -v -k "not harness_state_api"
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.diagnostics import Diagnostics
from harness.evidence import Evidence, EvidenceStore, ToolAvailability
from harness.execution import action_dep_overlap, execute, select_reversibility_strategy
from harness.hypothesis import Hypothesis, HypothesisSet
from harness.output_contract import OutputContract, contract_shadow_check
from harness.review_gate import (
    DimensionResult,
    apply_review_outcome,
    check_output_contract,
    check_world_model_consistency,
    review_proposed_change,
)
from harness.risk import RiskableAction, estimate_risk
from harness.task_graph import Task, TaskGraph
from harness.tool_manifest import ToolAvailabilityManifest, ToolEntry
from harness.verification import (
    verify,
    verify_evidence_sufficiency,
)
from harness.voi import estimate_voi
from harness.world_model import Belief, Observation, WorldModel


@pytest.fixture(autouse=True)
def _lexical_checks_on(monkeypatch):
    """These tests exercise the harness's lexical checks, which are off by default (harness/lexical_off.py)."""
    monkeypatch.setenv("HARNESS_LEXICAL_MODE", "enabled")


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
        status=status,  # type: ignore[arg-type]
    )
    if file_path:
        # Attach file_path as extra attribute
        object.__setattr__(t, "file_path", file_path) if hasattr(t, "__slots__") else setattr(t, "file_path", file_path)
    return t


def _world_model_with_refs(file_path: str, n_refs: int) -> WorldModel:
    """Create a world model with n_refs observations referencing file_path."""
    wm = WorldModel(generation_id=1)
    for i in range(n_refs):
        wm.observations.append(
            Observation(
                id=f"obs-{i}",
                content=f"reference to {file_path} in line {i}",
                source="test",
            )
        )
    return wm


def _belief(bid: str, statement: str, reliability: str = "", confidence: float = 0.9) -> Belief:
    # The review gate keys on confidence >= 0.8 (TS), so a LOW-reliability belief is one with low confidence.
    b = Belief(
        id=bid,
        statement=statement,
        confidence=0.3 if reliability == "LOW" else confidence,
        derived_from=["obs-1"],
    )
    b.reliability = reliability
    return b


def _make_manifest(available: list[str], unavailable: list[str] | None = None) -> ToolAvailabilityManifest:
    """Build a manifest with explicit availability settings."""
    manifest = ToolAvailabilityManifest()
    for tool in available:
        manifest._entries[tool] = ToolEntry(tool_name=tool, available=True, fallback_tool=None)
    for tool in unavailable or []:
        manifest._entries[tool] = ToolEntry(tool_name=tool, available=False, fallback_tool=None)
    manifest._freeze()
    return manifest


def _make_all_unavailable_manifest() -> ToolAvailabilityManifest:
    """Build a manifest with all verification tools unavailable."""
    all_tools = [
        "linter",
        "pytest",
        "integration_runner",
        "consistency_checker",
        "requirements_checker",
        "assumption_checker",
        "goal_checker",
        "evidence_checker",
        "contract_checker",
    ]
    return _make_manifest(available=[], unavailable=all_tools)


def _make_evidence_store(n_high: int = 0, n_medium: int = 0, n_low: int = 0) -> EvidenceStore:
    store = EvidenceStore()
    for i in range(n_high):
        store.append(
            Evidence(
                id=f"h-{i}",
                obs=f"high obs {i}",
                reliability="HIGH",
                source="test",
                evidence_type="OBSERVATION",
                freshness="2026-01-01T00:00:00+00:00",
            )
        )
    for i in range(n_medium):
        store.append(
            Evidence(
                id=f"m-{i}",
                obs=f"medium obs {i}",
                reliability="MEDIUM",
                source="test",
                evidence_type="OBSERVATION",
                freshness="2026-01-01T00:00:00+00:00",
            )
        )
    for i in range(n_low):
        store.append(
            Evidence(
                id=f"l-{i}",
                obs=f"low obs {i}",
                reliability="LOW",
                source="test",
                evidence_type="OBSERVATION",
                freshness="2026-01-01T00:00:00+00:00",
            )
        )
    return store


# ══════════════════════════════════════════════════════════════════════════════
# T01  Risk estimation (TS estimateRisk)
# ══════════════════════════════════════════════════════════════════════════════


def _graph_with_domains(*domains: str) -> TaskGraph:
    return TaskGraph(
        tasks=[Task(id=f"t{i}", description="t", parallel_write_domains=[d]) for i, d in enumerate(domains)]
    )


def test_T01_infrastructure_is_always_high_and_flags_metadata():
    """T01a — infrastructure modules are HIGH regardless of size and set reduce_edit_size / increase_verification."""
    action = RiskableAction(module_type="infrastructure", lines_affected=1)
    assert estimate_risk(action, TaskGraph(), WorldModel()) == "HIGH"
    assert action.metadata == {"reduce_edit_size": True, "increase_verification": True}


def test_T01_test_modules_are_always_low():
    """T01b — test modules are LOW even for a huge change, with no metadata flags."""
    action = RiskableAction(module_type="test", lines_affected=10_000, functions_affected=500)
    assert estimate_risk(action, TaskGraph(), WorldModel()) == "LOW"
    assert action.metadata == {}


def test_T01_business_logic_composite_thresholds():
    """T01c — composite = 0.3*centrality + 0.4*scope + 0.3*0.5; HIGH >= 0.5, MEDIUM >= 0.3, else LOW."""
    graph = _graph_with_domains("core/engine.py")
    # nothing changed, nothing central: 0.15 -> LOW
    assert estimate_risk(RiskableAction("business_logic"), graph, WorldModel()) == "LOW"
    # max size, fully central file: 0.3 + 0.4 + 0.15 = 0.85 -> HIGH (and flags set)
    big = RiskableAction("business_logic", ["core/engine.py"], lines_affected=500, functions_affected=20)
    assert estimate_risk(big, graph, WorldModel()) == "HIGH"
    assert big.metadata["increase_verification"] is True
    # scope 0.5 only: 0.2 + 0.15 = 0.35 -> MEDIUM
    mid = RiskableAction("business_logic", [], lines_affected=250, functions_affected=10)
    assert estimate_risk(mid, graph, WorldModel()) == "MEDIUM"
    assert mid.metadata == {}


# ══════════════════════════════════════════════════════════════════════════════
# T03-T06  VOI (TS estimateVOI)
# ══════════════════════════════════════════════════════════════════════════════


def _hyp_set(n: int) -> HypothesisSet:
    return HypothesisSet(active=[Hypothesis(id=f"h{i}", explanation="e", confidence=0.5) for i in range(n)])


def test_T03_voi_is_uncertainty_reduction_times_decision_impact():
    """T03 — VOI = ((n-1)/n) * (1 - strength); one active hypothesis leaves nothing to reduce."""
    diagnostics = Diagnostics()
    diagnostics.verification_health.strength = 0.2
    result = estimate_voi(diagnostics, WorldModel(), _hyp_set(4), {})
    assert result.voi == pytest.approx(0.75 * 0.8)
    assert result.should_gather_evidence is True  # voi 0.6 > 0.5

    assert estimate_voi(diagnostics, WorldModel(), _hyp_set(1), {}).voi == 0.0


def test_T04_high_strength_means_no_need_to_gather():
    """T04 — strong verification and a fully available toolset -> no gathering."""
    diagnostics = Diagnostics()
    diagnostics.verification_health.strength = 0.95
    manifest = {"linter": ToolAvailability(True), "pytest": ToolAvailability(True)}
    result = estimate_voi(diagnostics, WorldModel(), _hyp_set(3), manifest)
    assert result.should_gather_evidence is False
    assert result.adequacy_shortfall == 0
    assert result.adequacy_unresolvable is False
    assert result.updated_verification_strength is None


def test_T05_low_tool_adequacy_triggers_gathering_and_reports_shortfall():
    """T05 — adequacy = available / total; below 0.3 evidence is gathered and the shortfall is reported."""
    diagnostics = Diagnostics()
    diagnostics.verification_health.strength = 1.0
    manifest = {f"t{i}": ToolAvailability(i == 0, "alt" if i == 1 else None) for i in range(4)}  # adequacy 0.25
    result = estimate_voi(diagnostics, WorldModel(), _hyp_set(1), manifest)
    assert result.should_gather_evidence is True
    assert result.adequacy_shortfall == pytest.approx(0.05)
    assert result.adequacy_unresolvable is False  # one tool available, and one unavailable tool has a fallback


def test_T06_nothing_available_and_no_fallback_is_unresolvable_and_lowers_strength():
    """T06 — no available tool and no fallback -> unresolvable; verification_health.strength drops to the adequacy."""
    diagnostics = Diagnostics()
    diagnostics.verification_health.strength = 1.0
    manifest = {"linter": ToolAvailability(False), "pytest": ToolAvailability(False)}
    result = estimate_voi(diagnostics, WorldModel(), _hyp_set(1), manifest)
    assert result.adequacy_unresolvable is True
    assert result.updated_verification_strength == 0.0
    assert diagnostics.verification_health.strength == 0.0


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


# Regression: _is_negation used to require change_desc to literally contain "removes <full
# belief statement>" — a paraphrase describing the same subject in different words never
# matched. The fallback fires on a negation trigger word plus significant shared vocabulary.
def test_T07_paraphrased_negation_of_high_reliability_belief_fails():
    wm = WorldModel()
    high_belief = _belief("b1", "the login feature is required", reliability="HIGH")
    wm.beliefs.append(high_belief)

    proposed_change = {"description": "remove the old login feature entirely from the app"}

    result = check_world_model_consistency(proposed_change, wm)

    assert result.passed is False
    assert "HIGH-reliability" in result.reason


def test_T07_unrelated_change_sharing_only_a_trigger_word_does_not_fail():
    wm = WorldModel()
    high_belief = _belief("b1", "the login feature is required", reliability="HIGH")
    wm.beliefs.append(high_belief)

    proposed_change = {"description": "delete the temporary cache directory before redeploying"}

    result = check_world_model_consistency(proposed_change, wm)

    assert result.passed is True


# Chinese-language fixtures — first-pass phrasing, not verified by a fluent Chinese speaker; see
# the internal plan's Fixture-writing caveat.
def test_T07_chinese_literal_negation_trigger_concatenation_fails():
    """_is_negation's *primary* check — a trigger word immediately followed by the verbatim
    belief statement — is a plain substring check, so it works unchanged for Chinese."""
    wm = WorldModel()
    high_belief = _belief("b1", "登录功能是必需的", reliability="HIGH")
    wm.beliefs.append(high_belief)

    proposed_change = {"description": "移除登录功能是必需的"}

    result = check_world_model_consistency(proposed_change, wm)

    assert result.passed is False
    assert "HIGH-reliability" in result.reason


# Regression: _is_negation's *fallback* path (a trigger word + significant shared vocabulary)
# used to be structurally unable to fire for a belief statement made purely of CJK characters —
# tokenize() emits one token per CJK character, and the fallback filtered stmt_words to
# len(w) > 3 before computing overlap, which discarded every single-character CJK token. Fixed by
# exempting CJK tokens from that length cutoff (see _is_negation's own docstring) — this now
# behaves the same as the English "paraphrased negation" case above.
def test_T07_chinese_paraphrase_of_high_reliability_belief_fails():
    wm = WorldModel()
    high_belief = _belief("b1", "登录功能是必需的", reliability="HIGH")
    wm.beliefs.append(high_belief)

    # Contains the trigger word "移除" but is a paraphrase, not the verbatim statement.
    proposed_change = {"description": "把旧的登录功能彻底移除"}

    result = check_world_model_consistency(proposed_change, wm)

    assert result.passed is False
    assert "HIGH-reliability" in result.reason


# ══════════════════════════════════════════════════════════════════════════════
# T08  Change removing required_interface_field fails dimension 3
# ══════════════════════════════════════════════════════════════════════════════


def test_T08_removes_required_field_fails_contract_check():
    """T08 — change removing a required section fails output contract check."""
    contract = OutputContract(required_sections=["user_id", "session_token"])

    proposed_change = {"description": "remove user_id from the response payload"}

    result = check_output_contract(proposed_change, contract)

    assert result.passed is False
    assert "user_id" in result.reason


def test_T08_no_removal_passes_contract_check():
    """T08b — change not removing required fields passes."""
    contract = OutputContract(required_sections=["user_id"])
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
# Phase 2 (lexical hardening plan) — apply_review_outcome, extracted from
# review_proposed_change() so an external semantic check (an outer async driver
# layering one on top of review_proposed_change's own lexical dimensions) shares
# identical consecutive-failure/escalation bookkeeping instead of a second mechanism.
# ══════════════════════════════════════════════════════════════════════════════


def test_apply_review_outcome_resets_on_pass():
    failures_map: dict[str, int] = {"task-x": 1}
    result = apply_review_outcome("task-x", True, failures_map)
    assert result.passed is True
    assert result.failed_dimensions == []
    assert failures_map["task-x"] == 0


def test_apply_review_outcome_increments_and_carries_failed_dimensions_on_fail():
    failures_map: dict[str, int] = {}
    finding = DimensionResult(dimension="world_model_consistency", passed=False, reason="semantic conflict")

    first = apply_review_outcome("task-y", False, failures_map, [finding])
    assert first.passed is False
    assert first.consecutive_failures == 1
    assert first.escalation_triggered is False
    assert first.failed_dimensions == [finding]

    second = apply_review_outcome("task-y", False, failures_map, [finding])
    assert second.consecutive_failures == 2
    assert second.escalation_triggered is True  # ESCALATION_THRESHOLD == 2


def test_apply_review_outcome_is_the_same_bookkeeping_review_proposed_change_uses():
    """review_proposed_change's own consecutive-failure counting and apply_review_outcome's are
    the same underlying mechanism, not two divergent copies — driving both against the same
    failures_map produces identical escalation behavior."""
    failures_map_a: dict[str, int] = {}
    failures_map_b: dict[str, int] = {}
    task = _task("task-z", description="a change")

    for _ in range(2):
        via_review = review_proposed_change(
            proposed_change={},  # missing description → task_alignment dimension fails
            current_task=task,
            world_model=None,
            output_contract=None,
            hypothesis_set=None,
            tool_manifest=None,
            consecutive_failures_map=failures_map_a,
        )
        via_apply = apply_review_outcome(
            "task-z", False, failures_map_b, [DimensionResult(dimension="task_alignment", passed=False)]
        )

    assert via_review.escalation_triggered == via_apply.escalation_triggered
    assert via_review.consecutive_failures == via_apply.consecutive_failures


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


def test_T10c_system_error_evidence_prefixed_with_canonical_symptom():
    """T10c — recognized error signatures get a canonical symptom prefix on the obs text."""

    cases = [
        ("FileNotFoundError: [Errno 2] No such file or directory: '/x'", "file not found"),
        ("socket.timeout: The read operation timed out", "request timed out"),
        ("ConnectionRefusedError: [Errno 61] Connection refused", "connection refused"),
    ]

    for message, expected_symptom in cases:

        def failing_workflow(message: str = message) -> None:
            raise RuntimeError(message)

        wm = WorldModel()
        task = _task("t10c", risk_level="LOW")
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

        sys_errors = [e for e in evidence_store.entries if e.evidence_type == "SYSTEM_ERROR"]
        assert len(sys_errors) == 1
        assert sys_errors[0].obs == f"{expected_symptom} — Tool execution failed: {message}"


def test_T10d_system_error_evidence_unprefixed_when_unrecognized():
    """T10d — an unrecognized error signature leaves the obs text unprefixed."""

    def failing_workflow():
        raise RuntimeError("something bespoke went sideways")

    wm = WorldModel()
    task = _task("t10d", risk_level="LOW")
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

    sys_errors = [e for e in evidence_store.entries if e.evidence_type == "SYSTEM_ERROR"]
    assert len(sys_errors) == 1
    assert sys_errors[0].obs == "Tool execution failed: something bespoke went sideways"


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
    assert log_entry["id"].startswith("change-")
    assert log_entry["affected_paths"] == []
    assert log_entry["description"] == "execution"
    assert log_entry["timestamp"]


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


def test_T13_reversibility_depends_on_change_type_only():
    """T13 — read-only -> ephemeral; schema/infra -> snapshot; a file mutation is patch-rollback whatever the risk
    or the presence of a .git directory (TS selectReversibilityStrategy)."""
    assert select_reversibility_strategy({"change_type": "read-only"}) == "ephemeral"
    assert select_reversibility_strategy({"change_type": "schema"}) == "snapshot"
    assert select_reversibility_strategy({"change_type": "infra"}) == "snapshot"
    assert select_reversibility_strategy({"change_type": "file_mutation"}, "HIGH") == "patch-rollback"
    assert select_reversibility_strategy({}) == "patch-rollback"


def test_T13_file_mutation_low_risk_patch_rollback():
    """T13c — file mutation + LOW risk → 'patch-rollback' strategy."""
    proposed_change = {"change_type": "file_mutation"}
    strategy = select_reversibility_strategy(proposed_change, "LOW")
    assert strategy == "patch-rollback"


# ══════════════════════════════════════════════════════════════════════════════
# T14  Task status transitions during execution
# ══════════════════════════════════════════════════════════════════════════════


def test_T14_successful_execution_leaves_task_status_to_the_driver():
    """T14 — like TS execute(), a successful run does not change the task's status (the driver applies COMPLETE)."""
    task = _task("t14", risk_level="LOW")
    tg = TaskGraph(tasks=[task])
    wm = WorldModel()

    result = execute(
        proposed_change={"change_type": "file_mutation"},
        tool_workflow=lambda: "ok",
        world_model=wm,
        task_graph=tg,
        current_task=task,
        evidence_store=EvidenceStore(),
    )

    assert task.status == "PENDING"
    assert result.status == "complete"


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
        "linter",
        "pytest",
        "integration_runner",
        "consistency_checker",
        "requirements_checker",
        "assumption_checker",
        "goal_checker",
        "evidence_checker",
        "contract_checker",
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
        "syntax",
        "unit",
        "integration",
        "consistency",
        "requirements",
        "assumptions",
        "goal_correctness",
        "evidence_sufficiency",
        "output_contract_partial",
    ]:
        assert expected_layer in layer_names


def test_T15_unavailable_tool_gives_skipped_not_failed():
    """T15b — unavailable tool → layer status is SKIPPED, not FAILED."""
    # Make only linter unavailable
    manifest = _make_manifest(
        available=[
            "pytest",
            "integration_runner",
            "consistency_checker",
            "requirements_checker",
            "assumption_checker",
            "goal_checker",
            "evidence_checker",
            "contract_checker",
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
            "consistency_checker",
            "requirements_checker",
            "assumption_checker",
            "goal_checker",
            "contract_checker",
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


# ══════════════════════════════════════════════════════════════════════════════
# T19  Missing required_interface_field caught by shadow check, is_stub=False
# ══════════════════════════════════════════════════════════════════════════════


def test_T19_missing_required_section_caught_by_shadow_check():
    """T19 — contract_shadow_check catches a missing required_sections key of a dict result (TS contractShadowCheck)."""
    contract = OutputContract(required_sections=["status", "data"])
    result_dict = {"status": "ok"}  # missing "data"

    check = contract_shadow_check(result_dict, contract)

    assert check.passed is False
    assert check.is_stub is False
    assert check.violations == ["Missing required field: data"]
    assert contract_shadow_check("plain text", contract).passed is True  # non-dict results are not checked
    assert contract_shadow_check({}, None).passed is True


def test_T19_shadow_check_is_not_stub():
    """T19b — contract_shadow_check returns is_stub=False."""
    check = contract_shadow_check({}, OutputContract())
    assert check.is_stub is False


# ══════════════════════════════════════════════════════════════════════════════
# T20  Type regression caught by shadow check
# ══════════════════════════════════════════════════════════════════════════════


def test_T20_interface_constraint_mismatch_caught_by_output_validation():
    """T20 — a value that differs from interface_constraints[key] is a violation of the authoritative check."""
    from harness.output_contract import OutputContractError, output_validation

    contract = OutputContract(interface_constraints={"count": 3})
    with pytest.raises(OutputContractError) as exc:
        output_validation({"count": 4}, contract, None)
    assert exc.value.violated_dimension == "interface_constraints"
    assert exc.value.violations == ['interface_constraints: field "count" expected 3, got 4']
    assert output_validation({"count": 3}, contract, None).passed is True


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
