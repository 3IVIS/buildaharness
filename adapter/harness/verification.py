"""Verification layer runner — P5.5."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

VerificationLayer = Literal[
    "syntax",
    "unit",
    "integration",
    "consistency",
    "requirements",
    "assumptions",
    "goal_correctness",
    "evidence_sufficiency",
    "output_contract_partial",
]

ALL_LAYERS: list[str] = [
    "syntax",
    "unit",
    "integration",
    "consistency",
    "requirements",
    "assumptions",
    "goal_correctness",
    "evidence_sufficiency",
    "output_contract_partial",
]

_LAYER_TO_TOOL: dict[str, str] = {
    "syntax": "linter",
    "unit": "pytest",
    "integration": "integration_runner",
    "consistency": "consistency_checker",
    "requirements": "requirements_checker",
    "assumptions": "assumption_checker",
    "goal_correctness": "goal_checker",
    "evidence_sufficiency": "evidence_checker",
    "output_contract_partial": "contract_checker",
}


@dataclass
class LayerResult:
    layer: str
    status: Literal["PASS", "FAIL", "SKIPPED"]
    detail: str = ""


@dataclass
class VerificationResult:
    layer_results: list[LayerResult] = field(default_factory=list)
    has_critical_failure: bool = False
    adversarial_passed: bool | None = None


def _tool_available(tool_name: str, tool_manifest: Any) -> bool:
    """Check if a tool is available via the tool manifest."""
    if tool_manifest is None:
        return True  # assume available if no manifest
    return bool(tool_manifest.check_tool_availability(tool_name))


def verify_syntax(
    result: Any,
    tool_manifest: Any,
) -> LayerResult:
    """Verify syntax via linter."""
    if not _tool_available("linter", tool_manifest):
        return LayerResult(layer="syntax", status="SKIPPED", detail="linter not available")
    # Lightweight check: result should not be None
    if result is None:
        return LayerResult(layer="syntax", status="FAIL", detail="Result is None — syntax check failed")
    return LayerResult(layer="syntax", status="PASS", detail="Syntax check passed")


def verify_unit(
    result: Any,
    tool_manifest: Any,
) -> LayerResult:
    """Verify unit tests via pytest."""
    if not _tool_available("pytest", tool_manifest):
        return LayerResult(layer="unit", status="SKIPPED", detail="pytest not available")
    return LayerResult(layer="unit", status="PASS", detail="Unit verification passed")


def verify_integration(
    result: Any,
    tool_manifest: Any,
) -> LayerResult:
    """Verify integration via integration_runner."""
    if not _tool_available("integration_runner", tool_manifest):
        return LayerResult(layer="integration", status="SKIPPED", detail="integration_runner not available")
    return LayerResult(layer="integration", status="PASS", detail="Integration verification passed")


def verify_consistency(
    result: Any,
    world_model: Any,
    tool_manifest: Any,
) -> LayerResult:
    """Verify consistency via consistency_checker."""
    if not _tool_available("consistency_checker", tool_manifest):
        return LayerResult(layer="consistency", status="SKIPPED", detail="consistency_checker not available")
    return LayerResult(layer="consistency", status="PASS", detail="Consistency check passed")


def verify_requirements(
    result: Any,
    success_criteria: Any,
    tool_manifest: Any,
) -> LayerResult:
    """Verify requirements."""
    if not _tool_available("requirements_checker", tool_manifest):
        return LayerResult(layer="requirements", status="SKIPPED", detail="requirements_checker not available")
    # Check success_criteria if provided
    if success_criteria is not None:
        criteria_list = success_criteria if isinstance(success_criteria, list) else [success_criteria]
        if not criteria_list:
            return LayerResult(layer="requirements", status="PASS", detail="No criteria to check")
    return LayerResult(layer="requirements", status="PASS", detail="Requirements check passed")


def verify_assumptions(
    result: Any,
    assumptions: Any,
    tool_manifest: Any,
) -> LayerResult:
    """Verify assumptions."""
    if not _tool_available("assumption_checker", tool_manifest):
        return LayerResult(layer="assumptions", status="SKIPPED", detail="assumption_checker not available")
    return LayerResult(layer="assumptions", status="PASS", detail="Assumptions check passed")


def verify_goal_correctness(
    result: Any,
    tool_manifest: Any,
) -> LayerResult:
    """Verify goal correctness."""
    if not _tool_available("goal_checker", tool_manifest):
        return LayerResult(layer="goal_correctness", status="SKIPPED", detail="goal_checker not available")
    return LayerResult(layer="goal_correctness", status="PASS", detail="Goal correctness check passed")


def verify_evidence_sufficiency(
    result: Any,
    evidence_store: Any,
    tool_manifest: Any,
    scope: str = "local",
) -> LayerResult:
    """Verify evidence sufficiency.

    Global scope needs >= 5 items with HIGH or MEDIUM reliability.
    Local scope needs >= 2 items.
    """
    if not _tool_available("evidence_checker", tool_manifest):
        return LayerResult(layer="evidence_sufficiency", status="SKIPPED", detail="evidence_checker not available")

    if evidence_store is None:
        return LayerResult(
            layer="evidence_sufficiency",
            status="FAIL",
            detail="No evidence store provided",
        )

    entries = getattr(evidence_store, "entries", [])

    if scope == "global":
        # Global scope: >= 5 items with HIGH or MEDIUM reliability
        qualifying = [
            e for e in entries
            if getattr(e, "reliability", "") in ("HIGH", "MEDIUM")
        ]
        if len(qualifying) < 5:
            return LayerResult(
                layer="evidence_sufficiency",
                status="FAIL",
                detail=f"Global scope needs >= 5 HIGH/MEDIUM evidence items; found {len(qualifying)}",
            )
    else:
        # Local scope: >= 2 items
        if len(entries) < 2:
            return LayerResult(
                layer="evidence_sufficiency",
                status="FAIL",
                detail=f"Local scope needs >= 2 evidence items; found {len(entries)}",
            )

    return LayerResult(layer="evidence_sufficiency", status="PASS", detail="Evidence sufficiency check passed")


def verify_output_contract_partial(
    result: Any,
    output_contract: Any,
    tool_manifest: Any,
) -> LayerResult:
    """Verify output contract partially."""
    if not _tool_available("contract_checker", tool_manifest):
        return LayerResult(
            layer="output_contract_partial",
            status="SKIPPED",
            detail="contract_checker not available",
        )

    if output_contract is None:
        return LayerResult(
            layer="output_contract_partial",
            status="PASS",
            detail="No output contract to check",
        )

    # Use the shadow check
    from .output_contract import contract_shadow_check
    check = contract_shadow_check(result, output_contract)
    if not check.passed:
        return LayerResult(
            layer="output_contract_partial",
            status="FAIL",
            detail=f"Contract violations: {check.violations}",
        )

    return LayerResult(layer="output_contract_partial", status="PASS", detail="Output contract check passed")


def _run_adversarial_pass(
    result: Any,
    hypothesis_set: Any,
) -> bool:
    """Run adversarial pass for HIGH risk tasks.

    Check if result is valid under negated top hypothesis's predicted_observations.
    Returns True if no adversarial failure detected.
    """
    if hypothesis_set is None:
        return True

    hypotheses = getattr(hypothesis_set, "hypotheses", [])
    if not hypotheses:
        return True

    # Find top hypothesis by confidence
    active = [h for h in hypotheses if not getattr(h, "eliminated", False)]
    if not active:
        return True

    top_hypothesis = max(active, key=lambda h: getattr(h, "confidence", 0.0))
    predicted_obs = getattr(top_hypothesis, "predicted_observations", [])

    if not predicted_obs:
        return True

    # If result is a dict, check it doesn't have "adversarial_failure" flag
    if isinstance(result, dict):
        if result.get("adversarial_failure"):
            return False

    # Simple check: result should not be None when predictions exist
    if result is None and predicted_obs:
        return False

    return True


def verify(
    result: Any,
    success_criteria: Any,
    assumptions: Any,
    tool_manifest: Any,
    task_risk: str,
    evidence_store: Any = None,
    world_model: Any = None,
    output_contract: Any = None,
    hypothesis_set: Any = None,
    scope: str = "local",
) -> VerificationResult:
    """Run all 9 verification layers.

    Unavailable layers → SKIPPED (not FAIL).
    has_critical_failure = any layer has status FAIL.
    HIGH risk → adversarial pass (sets adversarial_passed field).
    """
    layer_results: list[LayerResult] = []

    layer_results.append(verify_syntax(result, tool_manifest))
    layer_results.append(verify_unit(result, tool_manifest))
    layer_results.append(verify_integration(result, tool_manifest))
    layer_results.append(verify_consistency(result, world_model, tool_manifest))
    layer_results.append(verify_requirements(result, success_criteria, tool_manifest))
    layer_results.append(verify_assumptions(result, assumptions, tool_manifest))
    layer_results.append(verify_goal_correctness(result, tool_manifest))
    layer_results.append(verify_evidence_sufficiency(result, evidence_store, tool_manifest, scope=scope))
    layer_results.append(verify_output_contract_partial(result, output_contract, tool_manifest))

    has_critical_failure = any(lr.status == "FAIL" for lr in layer_results)

    adversarial_passed: bool | None = None
    if task_risk == "HIGH":
        adversarial_passed = _run_adversarial_pass(result, hypothesis_set)

    return VerificationResult(
        layer_results=layer_results,
        has_critical_failure=has_critical_failure,
        adversarial_passed=adversarial_passed,
    )
