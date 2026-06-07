"""VOI estimation and verification adequacy critic — P5.2."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

VOI_THRESHOLD = 0.3
MIN_ADEQUATE_LAYERS = 3
MIN_RESOLVABLE_LAYERS = 2

VERIFICATION_LAYERS = [
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


@dataclass
class VOIResult:
    voi_score: float
    expected_uncertainty_reduction: float
    decision_impact: float
    should_gather: bool


@dataclass
class AdequacyResult:
    adequate: bool
    available_layers: list[str] = field(default_factory=list)
    pruned_layers: list[str] = field(default_factory=list)
    requires_adversarial_pass: bool = False
    resolution: Literal["proceed", "gather_evidence", "escalate"] = "proceed"


def estimate_value_of_information(
    evidence_store: Any,
    world_model: Any,
    current_task: Any,
    diagnostics: Any = None,
) -> VOIResult:
    """VOI = expected_uncertainty_reduction * decision_impact.

    expected_uncertainty_reduction = 1 - explanation_coverage
    decision_impact derived from task risk_level.
    """
    # Get explanation_coverage from diagnostics if available
    explanation_coverage = 0.5  # default
    if diagnostics is not None and hasattr(diagnostics, "coverage_health"):
        explanation_coverage = diagnostics.coverage_health.explanation_coverage
    elif hasattr(world_model, "_diagnostics"):
        d = world_model._diagnostics
        if d is not None and hasattr(d, "coverage_health"):
            explanation_coverage = d.coverage_health.explanation_coverage

    uncertainty_reduction = max(0.0, min(1.0, 1.0 - explanation_coverage))

    # decision_impact from risk_level
    risk_level = getattr(current_task, "risk_level", "LOW")
    impact_map = {"LOW": 0.3, "MEDIUM": 0.6, "HIGH": 1.0}
    decision_impact = impact_map.get(str(risk_level), 0.3)

    voi_score = uncertainty_reduction * decision_impact
    should_gather = voi_score > VOI_THRESHOLD

    return VOIResult(
        voi_score=voi_score,
        expected_uncertainty_reduction=uncertainty_reduction,
        decision_impact=decision_impact,
        should_gather=should_gather,
    )


def verification_adequacy_critic(
    tool_manifest: Any,
    task_risk: str,
    evidence_store: Any,
) -> AdequacyResult:
    """Check which verification layers are available and enforce minimum adequacy.

    Checks all 9 verification layers against the tool manifest.
    < MIN_RESOLVABLE_LAYERS (2) available -> escalate
    < MIN_ADEQUATE_LAYERS (3) available -> gather_evidence
    >= MIN_ADEQUATE_LAYERS (3) available -> proceed
    HIGH risk always sets requires_adversarial_pass=True.
    """
    available = []
    pruned = []

    for layer in VERIFICATION_LAYERS:
        tool_name = _layer_to_tool(layer)
        if tool_manifest is None or tool_manifest.check_tool_availability(tool_name):
            available.append(layer)
        else:
            pruned.append(layer)

    requires_adversarial = task_risk == "HIGH"
    n_available = len(available)

    if n_available < MIN_RESOLVABLE_LAYERS:
        return AdequacyResult(
            adequate=False,
            available_layers=available,
            pruned_layers=pruned,
            requires_adversarial_pass=requires_adversarial,
            resolution="escalate",
        )
    elif n_available < MIN_ADEQUATE_LAYERS:
        return AdequacyResult(
            adequate=False,
            available_layers=available,
            pruned_layers=pruned,
            requires_adversarial_pass=requires_adversarial,
            resolution="gather_evidence",
        )
    else:
        return AdequacyResult(
            adequate=True,
            available_layers=available,
            pruned_layers=pruned,
            requires_adversarial_pass=requires_adversarial,
            resolution="proceed",
        )


def update_verification_strength(diagnostics: Any, available_layer_count: int) -> None:
    """Reduce verification_health.strength based on available layers."""
    strength = max(0.0, min(1.0, available_layer_count / len(VERIFICATION_LAYERS)))
    if hasattr(diagnostics, "verification_health"):
        diagnostics.verification_health.strength = strength


def _layer_to_tool(layer: str) -> str:
    """Map verification layer name to a tool name."""
    mapping = {
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
    return mapping.get(layer, layer)
