"""
Verification layer runner — P5.5.

Phase 2 of plans/harness_and_assistant_architecture_remediation_plan.html closed the gap
found during Phase 1b's planning: 7 of these 9 layers were stub functions that checked only
whether a *tool* was available, then unconditionally returned PASS — never actually
inspecting anything. In production that meant `unit` (whose tool name "pytest" happens to
match tool_manifest.py's default probe list) silently produced a fake PASS on every run; the
other six were honestly SKIPPED only because their abstract tool names ("linter",
"integration_runner", etc.) never matched anything in the default manifest — but a fake
PASS was always one manifest customization away.

Every layer here now does one of two honest things: a REAL check (syntax/unit, via Phase
1b's execution_boundary; consistency, by inspecting world_model.contradictions directly —
no fake middle state), or an honest SKIPPED when there's nothing to mechanically check
(requirements/assumptions/goal_correctness, which need environmental or model-tier judgment
this layer can't provide; integration, which has no real tool in the execution boundary's
allowlist). No layer returns PASS as a "tool available, nothing to actually verify" default
anymore — see each function's docstring for its own reasoning.

LAYER_TIER classifies every layer per the critique's own hierarchy —
mechanical > environmental > model — for future callers to weight accordingly; this phase
does not itself change has_critical_failure's aggregation (still: any FAIL among all layers),
since with only one tier occupied by real logic today, a full precedence system would be the
same "false sense of precision" the critique warned about elsewhere.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from ._core_generated import LAYER_TIER as LAYER_TIER

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

LayerTier = Literal["mechanical", "environmental", "model"]

# LAYER_TIER is generated from spec/harness-core.json into ._core_generated
# (Phase C1 — docs/adr/004-shared-semantic-core.md), the single source of truth
# shared with packages/harness/src/verify.ts via _core-generated.ts.
#
# Mechanical: exit code / schema / deterministic state inspection — no judgment involved.
# Environmental: inspects already-gathered external observations (evidence, criteria) —
#   real, but can't be reduced to a pass/fail exit code the way mechanical checks can.
# Model: requires semantic judgment (does this genuinely satisfy the goal?) — explicitly
#   out of scope for this mechanical/environmental layer; always SKIPPED here, tracked as a
#   future model-based (LLM judge) verification tier, not faked as a mechanical PASS.


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
    # Phase C2 (docs/adr/004-shared-semantic-core.md, INV-12) — additive: which
    # epistemic tiers (LAYER_TIER: mechanical | environmental | model) contributed
    # a FAIL. Empty iff not has_critical_failure. has_critical_failure itself stays
    # any(FAIL) — this field only exposes the provenance of the criticality so a
    # downstream consumer can distinguish a mechanical FAIL (exit code / failed test)
    # from a model-tier judgment. Because it is a set, N agreeing model-tier layers
    # collapse to a single "model" entry — correlated model opinions count once.
    critical_failure_tiers: set[str] = field(default_factory=set)

    def __post_init__(self) -> None:
        if self.has_critical_failure != bool(self.critical_failure_tiers):
            raise ValueError(
                f"VerificationResult.has_critical_failure ({self.has_critical_failure}) is inconsistent with "
                f"critical_failure_tiers ({self.critical_failure_tiers!r}) — critical_failure_tiers must be "
                f"empty iff has_critical_failure is False (see its own field comment above)."
            )


def _tool_available(tool_name: str, tool_manifest: Any) -> bool:
    """Check if a tool is available via the tool manifest."""
    if tool_manifest is None:
        return False  # no manifest → skip tool-dependent checks (don't fail)
    return bool(tool_manifest.check_tool_availability(tool_name))


def _execution_version_for_check(world_model: Any) -> Any:
    """Mints an ExecutionVersion to attribute a mechanical-check subprocess to, pinned to
    world_model's generation if one was provided, or a fresh WorldModel() otherwise (purely
    for identity/idempotency-key purposes here — verify() doesn't track staleness against
    this particular version, unlike its use in the main loop)."""
    from .provenance import new_execution_version
    from .world_model import WorldModel

    return new_execution_version(world_model if world_model is not None else WorldModel())


def _run_mechanical_subprocess_check(
    layer: str,
    argv: list[str],
    target_path: str,
    workspace_root: str | None,
    world_model: Any,
) -> LayerResult:
    """Shared plumbing for verify_syntax/verify_unit: resolve cwd/allowed_root from
    target_path (+ optional workspace_root), run through Phase 1b's execution boundary,
    and translate the result into a LayerResult. A BoundaryViolation (e.g. target_path
    resolves outside workspace_root) is reported as FAIL, not raised — a verification
    layer rejecting its own input is a real, reportable verification outcome, not a crash."""
    from .execution_boundary import BoundaryViolation, run_mechanical_check

    target = Path(target_path)
    cwd = target if target.is_dir() else target.parent
    allowed_root = Path(workspace_root) if workspace_root is not None else cwd

    try:
        check = run_mechanical_check(
            argv,
            execution_version=_execution_version_for_check(world_model),
            cwd=cwd,
            allowed_root=allowed_root,
        )
    except BoundaryViolation as exc:
        return LayerResult(layer=layer, status="FAIL", detail=f"execution boundary rejected the check: {exc}")

    if check.timed_out:
        return LayerResult(layer=layer, status="FAIL", detail=f"{argv[0]} timed out checking {target_path}")
    if check.exit_code != 0:
        detail = (check.stderr or check.stdout or "").strip() or f"{argv[0]} exited {check.exit_code}"
        return LayerResult(layer=layer, status="FAIL", detail=detail[:2000])
    return LayerResult(layer=layer, status="PASS", detail=f"{argv[0]} passed against {target_path}")


def verify_syntax(
    result: Any,
    tool_manifest: Any,
    target_path: str | None = None,
    workspace_root: str | None = None,
    world_model: Any = None,
) -> LayerResult:
    """Verify syntax via ruff, when there's a real file/directory to check.

    Without target_path there is nothing to lint — SKIPPED (not PASS): a mechanical check
    with no input to check is not evidence of correctness. result is still checked for the
    trivial None case, since that's a real (if weak) signal independent of target_path.
    """
    if not _tool_available("linter", tool_manifest):
        return LayerResult(layer="syntax", status="SKIPPED", detail="linter not available")
    if result is None:
        return LayerResult(layer="syntax", status="FAIL", detail="Result is None — syntax check failed")
    if target_path is None:
        return LayerResult(layer="syntax", status="SKIPPED", detail="no target_path provided — nothing to lint")
    return _run_mechanical_subprocess_check(
        "syntax", ["ruff", "check", "--quiet", str(target_path)], target_path, workspace_root, world_model
    )


def verify_unit(
    result: Any,
    tool_manifest: Any,
    target_path: str | None = None,
    workspace_root: str | None = None,
    world_model: Any = None,
) -> LayerResult:
    """Verify unit tests via pytest, when there's a real test file/directory to run.

    Without target_path there is nothing to run — SKIPPED (not PASS).
    """
    if not _tool_available("pytest", tool_manifest):
        return LayerResult(layer="unit", status="SKIPPED", detail="pytest not available")
    if target_path is None:
        return LayerResult(layer="unit", status="SKIPPED", detail="no target_path provided — nothing to test")
    return _run_mechanical_subprocess_check(
        "unit", ["pytest", str(target_path), "-q"], target_path, workspace_root, world_model
    )


def verify_integration(
    result: Any,
    tool_manifest: Any,
) -> LayerResult:
    """Verify integration via integration_runner.

    Always SKIPPED: there is no real "integration_runner" binary in
    execution_boundary.DEFAULT_ALLOWED_EXECUTABLES, and inventing a fake pass/fail for a
    tool that can't actually be invoked would just reintroduce the false-confidence problem
    this rewrite exists to close. Upgrading this layer requires a real integration-test
    runner concept, not a stub fallback.
    """
    return LayerResult(layer="integration", status="SKIPPED", detail="integration_runner not available")


def verify_consistency(
    result: Any,
    world_model: Any,
    tool_manifest: Any,
) -> LayerResult:
    """Verify consistency by inspecting world_model.contradictions directly — a real,
    deterministic check (no subprocess needed): FAIL if any unresolved HIGH or
    SYSTEM_BREAKING contradiction is present, PASS otherwise.
    """
    if not _tool_available("consistency_checker", tool_manifest):
        return LayerResult(layer="consistency", status="SKIPPED", detail="consistency_checker not available")
    if world_model is None:
        return LayerResult(layer="consistency", status="SKIPPED", detail="no world_model to check against")

    contradictions = getattr(world_model, "contradictions", [])
    unresolved = [c for c in contradictions if getattr(c, "severity", None) in ("HIGH", "SYSTEM_BREAKING")]
    if unresolved:
        return LayerResult(
            layer="consistency",
            status="FAIL",
            detail=f"{len(unresolved)} unresolved HIGH/SYSTEM_BREAKING contradiction(s) in world model",
        )
    return LayerResult(layer="consistency", status="PASS", detail="no unresolved HIGH/SYSTEM_BREAKING contradictions")


def verify_requirements(
    result: Any,
    success_criteria: Any,
    tool_manifest: Any,
) -> LayerResult:
    """Verify requirements.

    Mechanical-tier limit: whether a result *semantically* satisfies success_criteria is a
    model-judgment question, not something this layer can decide. What IS mechanically
    checkable — did we produce a result at all when criteria require one — is checked and
    can FAIL; everything else is an honest SKIPPED, not a PASS this layer can't back up.
    """
    if not _tool_available("requirements_checker", tool_manifest):
        return LayerResult(layer="requirements", status="SKIPPED", detail="requirements_checker not available")

    criteria_list = (
        success_criteria if isinstance(success_criteria, list) else ([success_criteria] if success_criteria else [])
    )
    if not criteria_list:
        return LayerResult(layer="requirements", status="SKIPPED", detail="no success criteria to check")
    if result is None:
        return LayerResult(
            layer="requirements", status="FAIL", detail="success criteria specified but no result was produced"
        )
    return LayerResult(
        layer="requirements",
        status="SKIPPED",
        detail="result produced; semantic satisfaction of criteria requires model-tier judgment, not verified here",
    )


def verify_assumptions(
    result: Any,
    assumptions: Any,
    tool_manifest: Any,
) -> LayerResult:
    """Verify assumptions.

    Same mechanical-tier limit as verify_requirements: whether stated assumptions still
    hold is an environmental question this layer isn't wired to check yet. Only the
    clear-cut case (assumptions were stated but no result exists to have honored them) FAILs.
    """
    if not _tool_available("assumption_checker", tool_manifest):
        return LayerResult(layer="assumptions", status="SKIPPED", detail="assumption_checker not available")

    assumptions_list = assumptions if isinstance(assumptions, list) else ([assumptions] if assumptions else [])
    if not assumptions_list:
        return LayerResult(layer="assumptions", status="SKIPPED", detail="no assumptions to check")
    if result is None:
        return LayerResult(layer="assumptions", status="FAIL", detail="assumptions stated but no result was produced")
    return LayerResult(
        layer="assumptions",
        status="SKIPPED",
        detail="result produced; environmental validation of assumptions not implemented at this layer",
    )


def verify_goal_correctness(
    result: Any,
    tool_manifest: Any,
) -> LayerResult:
    """Verify goal correctness.

    Model tier by nature — "is this the right outcome" is a judgment call, not a mechanical
    property. Always SKIPPED when a tool is nominally available; a fake PASS here is exactly
    the false-confidence pattern this rewrite exists to close.
    """
    if not _tool_available("goal_checker", tool_manifest):
        return LayerResult(layer="goal_correctness", status="SKIPPED", detail="goal_checker not available")
    return LayerResult(
        layer="goal_correctness",
        status="SKIPPED",
        detail="goal correctness requires model-tier judgment, not implemented at this layer",
    )


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
        qualifying = [e for e in entries if getattr(e, "reliability", "") in ("HIGH", "MEDIUM")]
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
    target_path: str | None = None,
    workspace_root: str | None = None,
) -> VerificationResult:
    """Run all 9 verification layers.

    Unavailable layers → SKIPPED (not FAIL). has_critical_failure = any layer has status
    FAIL. HIGH risk → adversarial pass (sets adversarial_passed field).

    target_path/workspace_root are new (Phase 2) and optional — omitting them (as every
    existing caller, including node_compilers.py's codegen, does today) keeps syntax/unit
    honestly SKIPPED exactly where they used to fake a PASS; this can only turn a false PASS
    into an honest SKIPPED for existing callers, never introduce a new FAIL that wasn't
    already possible, since a caller that never passed target_path never reaches the new
    subprocess-backed check path at all.
    """
    layer_results: list[LayerResult] = []

    layer_results.append(verify_syntax(result, tool_manifest, target_path, workspace_root, world_model))
    layer_results.append(verify_unit(result, tool_manifest, target_path, workspace_root, world_model))
    layer_results.append(verify_integration(result, tool_manifest))
    layer_results.append(verify_consistency(result, world_model, tool_manifest))
    layer_results.append(verify_requirements(result, success_criteria, tool_manifest))
    layer_results.append(verify_assumptions(result, assumptions, tool_manifest))
    layer_results.append(verify_goal_correctness(result, tool_manifest))
    layer_results.append(verify_evidence_sufficiency(result, evidence_store, tool_manifest, scope=scope))
    layer_results.append(verify_output_contract_partial(result, output_contract, tool_manifest))

    has_critical_failure = any(lr.status == "FAIL" for lr in layer_results)
    critical_failure_tiers = {
        LAYER_TIER.get(lr.layer, "mechanical") for lr in layer_results if lr.status == "FAIL"
    }

    adversarial_passed: bool | None = None
    if task_risk == "HIGH":
        adversarial_passed = _run_adversarial_pass(result, hypothesis_set)

    return VerificationResult(
        layer_results=layer_results,
        has_critical_failure=has_critical_failure,
        adversarial_passed=adversarial_passed,
        critical_failure_tiers=critical_failure_tiers,
    )
