"""
Phase C2 (plans/harness_consolidation_and_control_plane_plan.html;
docs/adr/004-shared-semantic-core.md) — additive fields on the shared semantic core.

Covers:
  - the Failure -> Classification -> Recovery Policy table (criticism002 #7):
    classify_recovery() is a pure lookup; unclassified failures fall through.
  - VerificationResult.critical_failure_tiers (INV-12): non-empty iff
    has_critical_failure; agreeing model-tier layers collapse to one entry.

Run with: pytest adapter/tests/test_harness_c2.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from harness._core_generated import RECOVERY_CLASSIFICATION_TABLE
from harness.recovery import RecoveryPolicy, classify_recovery
from harness.verification import LayerResult, VerificationResult, verify

# ── Recovery classification -> policy table ───────────────────────────────────


def test_classify_recovery_known_class_short_circuits() -> None:
    policy = classify_recovery("timeout")
    assert policy == RecoveryPolicy(failure_class="timeout", policy="retry_with_backoff", action="execution_retry")


def test_classify_recovery_unclassified_returns_none() -> None:
    assert classify_recovery(None) is None
    assert classify_recovery("") is None
    assert classify_recovery("some_failure_mode_not_in_the_table") is None


def test_classify_recovery_covers_every_table_row() -> None:
    for failure_class, entry in RECOVERY_CLASSIFICATION_TABLE.items():
        policy = classify_recovery(failure_class)
        assert policy is not None
        assert policy.policy == entry["policy"]
        assert policy.action == entry["action"]


def test_recovery_table_actions_are_recovery_action_classes_or_terminal() -> None:
    from harness._core_generated import DIMENSION_RECOVERY

    valid_actions = set(DIMENSION_RECOVERY.values()) | {"escalate", "escalation_halt", "replan"}
    for entry in RECOVERY_CLASSIFICATION_TABLE.values():
        assert entry["action"] in valid_actions


# ── VerificationResult.critical_failure_tiers (INV-12) ────────────────────────


def test_critical_failure_tiers_empty_when_no_failure() -> None:
    result = VerificationResult(layer_results=[LayerResult(layer="syntax", status="PASS")])
    assert result.critical_failure_tiers == set()


class _AllToolsManifest:
    def check_tool_availability(self, _tool_name: str) -> bool:
        return True


def test_inv12_non_empty_iff_has_critical_failure() -> None:
    # A real verify() run that FAILs consistency (a mechanical-tier layer).
    from harness.world_model import WorldModel

    wm = WorldModel()
    wm.contradictions.append(type("C", (), {"severity": "SYSTEM_BREAKING", "resolved": False})())
    vr = verify(
        result={"ok": True},
        success_criteria=None,
        assumptions=None,
        tool_manifest=_AllToolsManifest(),
        task_risk="LOW",
        world_model=wm,
    )
    assert vr.has_critical_failure is True
    assert vr.critical_failure_tiers  # non-empty
    assert "mechanical" in vr.critical_failure_tiers  # consistency is mechanical tier


def test_inv12_no_failure_means_empty_tiers_from_verify() -> None:
    vr = verify(
        result={"ok": True},
        success_criteria=None,
        assumptions=None,
        tool_manifest=None,
        task_risk="LOW",
    )
    assert vr.has_critical_failure is False
    assert vr.critical_failure_tiers == set()


def test_inv12_agreeing_model_tier_layers_count_once() -> None:
    # critical_failure_tiers is a set — N FAILs in the same tier collapse to one entry.
    results = [
        LayerResult(layer="goal_correctness", status="FAIL"),  # model tier
        LayerResult(layer="goal_correctness", status="FAIL"),  # a hypothetical second model-tier layer
    ]
    from harness._core_generated import LAYER_TIER

    tiers = {LAYER_TIER.get(lr.layer, "mechanical") for lr in results if lr.status == "FAIL"}
    assert tiers == {"model"}
