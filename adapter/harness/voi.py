"""VOI estimation and verification adequacy — P5.2.

Twin of packages/harness/src/nodes/estimate-voi.ts.

  VOI = expected_uncertainty_reduction x decision_impact
      = ((n_active - 1) / n_active)  x  (1 - verification_health.strength)

Tool adequacy is the share of registered tools that are available. Evidence is worth gathering when VOI > 0.5 or
adequacy < 0.3; adequacy is *unresolvable* when it is below 0.3, no unavailable tool has a fallback and nothing is
available — in which case verification_health.strength is lowered to the adequacy.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .diagnostics import normalise

LOW_ADEQUACY_THRESHOLD = 0.3
HIGH_VOI_THRESHOLD = 0.5


@dataclass
class VOIResult:
    voi: float
    should_gather_evidence: bool
    adequacy_shortfall: float
    adequacy_unresolvable: bool
    updated_verification_strength: float | None


def estimate_voi(
    diagnostics: Any,
    world_model: Any,
    hypothesis_set: Any,
    tool_availability_manifest: dict[str, Any],
) -> VOIResult:
    """Value of gathering more evidence (TS estimateVOI). `tool_availability_manifest` maps tool name ->
    ToolAvailability(available, fallback_tool) (an EvidenceStore's `tool_availability_manifest`)."""
    active_count = len(hypothesis_set.active)
    expected_reduction = (active_count - 1) / active_count if active_count > 1 else 0.0
    decision_impact = 1 - diagnostics.verification_health.strength
    voi = normalise(expected_reduction * decision_impact, "ratio")

    tools = list(tool_availability_manifest.values())
    available_count = sum(1 for t in tools if t.available)
    adequacy = 1.0 if not tools else available_count / len(tools)

    adequacy_shortfall = max(0.0, LOW_ADEQUACY_THRESHOLD - adequacy)
    should_gather = voi > HIGH_VOI_THRESHOLD or adequacy < LOW_ADEQUACY_THRESHOLD

    has_any_fallback = any((not t.available) and t.fallback_tool is not None for t in tools)
    unresolvable = adequacy < LOW_ADEQUACY_THRESHOLD and not has_any_fallback and available_count == 0

    updated: float | None = None
    if unresolvable:
        # feeds the next resolve_control_state() Tier 2
        updated = normalise(adequacy, "ratio")
        diagnostics.verification_health.strength = updated

    return VOIResult(
        voi=voi,
        should_gather_evidence=should_gather,
        adequacy_shortfall=adequacy_shortfall,
        adequacy_unresolvable=unresolvable,
        updated_verification_strength=updated,
    )
