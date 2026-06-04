"""Review gate — pre-execution proposed change gating — P5.3."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

ReviewDimension = Literal[
    "task_alignment",
    "world_model_consistency",
    "output_contract_precheck",
    "code_quality",
    "hypothesis_compatibility",
]

ESCALATION_THRESHOLD = 2  # consecutive failures before escalation


@dataclass
class DimensionResult:
    dimension: ReviewDimension
    passed: bool
    reason: str = ""


@dataclass
class ReviewResult:
    passed: bool
    failed_dimensions: list[DimensionResult] = field(default_factory=list)
    consecutive_failures: int = 0
    escalation_triggered: bool = False


def check_task_alignment(proposed_change: Any, current_task: Any) -> DimensionResult:
    """Check that the proposed change is aligned with the current task description."""
    if current_task is None:
        return DimensionResult(
            dimension="task_alignment",
            passed=True,
            reason="No current task — alignment not applicable",
        )

    task_desc = str(getattr(current_task, "description", "") or "").lower()
    change_desc = _get_change_description(proposed_change).lower()

    # Simple heuristic: if task has a description, change should be non-empty
    if task_desc and not change_desc:
        return DimensionResult(
            dimension="task_alignment",
            passed=False,
            reason="Proposed change has no description but task requires one",
        )

    return DimensionResult(
        dimension="task_alignment",
        passed=True,
        reason="Change aligns with task",
    )


def check_world_model_consistency(
    proposed_change: Any,
    world_model: Any,
) -> DimensionResult:
    """Fail if the proposed change contradicts a HIGH-reliability belief.

    A 'contradiction' is detected when the proposed change description
    explicitly negates a HIGH-reliability belief statement (simple text match).
    """
    if world_model is None:
        return DimensionResult(
            dimension="world_model_consistency",
            passed=True,
            reason="No world model provided",
        )

    change_desc = _get_change_description(proposed_change).lower()
    beliefs = getattr(world_model, "beliefs", [])

    for belief in beliefs:
        reliability = str(getattr(belief, "reliability", "") or "").upper()
        if reliability != "HIGH":
            continue
        stmt = str(getattr(belief, "statement", "") or "").lower()
        # Check for simple negation: "not <stmt>" or "removes <stmt>" etc.
        if _is_negation(change_desc, stmt):
            return DimensionResult(
                dimension="world_model_consistency",
                passed=False,
                reason=f"Change contradicts HIGH-reliability belief: {stmt!r}",
            )

    return DimensionResult(
        dimension="world_model_consistency",
        passed=True,
        reason="No contradiction with world model beliefs",
    )


def check_output_contract(
    proposed_change: Any,
    output_contract: Any,
) -> DimensionResult:
    """Fail if the change removes a required_interface_field.

    Detects removal patterns like 'remove <field>', 'delete <field>', 'drop <field>'.
    """
    if output_contract is None:
        return DimensionResult(
            dimension="output_contract_precheck",
            passed=True,
            reason="No output contract provided",
        )

    required_fields = getattr(output_contract, "required_interface_fields", [])
    change_desc = _get_change_description(proposed_change).lower()

    for field_name in required_fields:
        fn_lower = field_name.lower()
        removal_patterns = [
            f"remove {fn_lower}",
            f"delete {fn_lower}",
            f"drop {fn_lower}",
            f"removes {fn_lower}",
        ]
        if any(pat in change_desc for pat in removal_patterns):
            return DimensionResult(
                dimension="output_contract_precheck",
                passed=False,
                reason=f"Change removes required interface field: {field_name!r}",
            )

    return DimensionResult(
        dimension="output_contract_precheck",
        passed=True,
        reason="No required interface fields removed",
    )


def check_code_quality(
    proposed_change: Any,
    tool_manifest: Any,
) -> DimensionResult:
    """Skip if no linter available; otherwise run basic quality check."""
    if tool_manifest is None:
        return DimensionResult(
            dimension="code_quality",
            passed=True,
            reason="No tool manifest — code quality check skipped",
        )

    # Check if any linter is available
    has_linter = (
        tool_manifest.check_tool_availability("linter")
        or tool_manifest.check_tool_availability("pylint")
        or tool_manifest.check_tool_availability("ruff")
    )

    if not has_linter:
        return DimensionResult(
            dimension="code_quality",
            passed=True,
            reason="No linter available — code quality check skipped",
        )

    # With linter available, do a lightweight check
    # In a real system this would invoke the linter; here we pass unless
    # the change explicitly marks itself as low-quality
    change_desc = _get_change_description(proposed_change).lower()
    if "syntax error" in change_desc or "invalid code" in change_desc:
        return DimensionResult(
            dimension="code_quality",
            passed=False,
            reason="Change description indicates code quality issues",
        )

    return DimensionResult(
        dimension="code_quality",
        passed=True,
        reason="Code quality check passed",
    )


def check_hypothesis_compatibility(
    proposed_change: Any,
    hypothesis_set: Any,
) -> DimensionResult:
    """Check that the proposed change is compatible with the active hypothesis set."""
    if hypothesis_set is None:
        return DimensionResult(
            dimension="hypothesis_compatibility",
            passed=True,
            reason="No hypothesis set provided",
        )

    hypotheses = getattr(hypothesis_set, "hypotheses", [])
    change_desc = _get_change_description(proposed_change).lower()

    for h in hypotheses:
        # Only check active/non-eliminated hypotheses
        eliminated = getattr(h, "eliminated", False)
        if eliminated:
            continue
        predicted_obs = getattr(h, "predicted_observations", [])
        for obs in predicted_obs:
            obs_lower = str(obs).lower()
            if _is_negation(change_desc, obs_lower):
                return DimensionResult(
                    dimension="hypothesis_compatibility",
                    passed=False,
                    reason=f"Change contradicts predicted observation: {obs!r}",
                )

    return DimensionResult(
        dimension="hypothesis_compatibility",
        passed=True,
        reason="Compatible with active hypotheses",
    )


def review_proposed_change(
    proposed_change: Any,
    current_task: Any,
    world_model: Any,
    output_contract: Any,
    hypothesis_set: Any,
    tool_manifest: Any,
    consecutive_failures_map: dict[str, int],
) -> ReviewResult:
    """Run all 5 review dimensions against the proposed change.

    Tracks consecutive failures per task_id in consecutive_failures_map.
    If consecutive_failures >= ESCALATION_THRESHOLD (2), sets escalation path.
    """
    task_id = str(getattr(current_task, "id", "default") or "default")

    dim_results = [
        check_task_alignment(proposed_change, current_task),
        check_world_model_consistency(proposed_change, world_model),
        check_output_contract(proposed_change, output_contract),
        check_code_quality(proposed_change, tool_manifest),
        check_hypothesis_compatibility(proposed_change, hypothesis_set),
    ]

    failed = [r for r in dim_results if not r.passed]
    overall_passed = len(failed) == 0

    # Update consecutive failures tracking
    if not overall_passed:
        consecutive_failures_map[task_id] = consecutive_failures_map.get(task_id, 0) + 1
    else:
        consecutive_failures_map[task_id] = 0

    consec = consecutive_failures_map.get(task_id, 0)
    escalation_triggered = consec >= ESCALATION_THRESHOLD

    return ReviewResult(
        passed=overall_passed,
        failed_dimensions=failed,
        consecutive_failures=consec,
        escalation_triggered=escalation_triggered,
    )


# ── Internal helpers ──────────────────────────────────────────────────────────


def _get_change_description(proposed_change: Any) -> str:
    """Extract a text description from a proposed change object or dict."""
    if isinstance(proposed_change, dict):
        return str(proposed_change.get("description", "") or "")
    return str(getattr(proposed_change, "description", "") or "")


def _is_negation(change_desc: str, belief_stmt: str) -> bool:
    """Check if change_desc negates belief_stmt via simple text patterns."""
    if not belief_stmt or not change_desc:
        return False
    negation_patterns = [
        f"not {belief_stmt}",
        f"removes {belief_stmt}",
        f"remove {belief_stmt}",
        f"delete {belief_stmt}",
        f"revert {belief_stmt}",
        f"contradicts {belief_stmt}",
        f"negate {belief_stmt}",
        f"negates {belief_stmt}",
        f"no longer {belief_stmt}",
    ]
    return any(pat in change_desc for pat in negation_patterns)
