import type { WorldModel } from '../state/world-model.js'
import type { EvidenceStore } from '../state/evidence-store.js'
import type { OutputContract } from '../state/output-contract.js'
import type { HypothesisSet } from '../state/hypothesis-set.js'
import type { RiskLevel } from '../state/task-graph.js'
import { contractShadowCheck } from './policy-gates.js'
import { LAYER_TIER, type LayerTier } from '../_core-generated.js'

export type VerificationLayer =
  | 'syntax'
  | 'unit'
  | 'integration'
  | 'consistency'
  | 'requirements'
  | 'assumptions'
  | 'goal_correctness'
  | 'evidence_sufficiency'
  | 'output_contract_partial'

export interface LayerResult {
  layer: VerificationLayer
  status: 'PASS' | 'FAIL' | 'SKIPPED'
  detail: string
}

export interface VerificationResult {
  layer_results: LayerResult[]
  has_critical_failure: boolean
  adversarial_passed: boolean | null
}

// LayerTier / LAYER_TIER are generated from spec/harness-core.json into
// _core-generated.ts (Phase C1 — docs/adr/004-shared-semantic-core.md), the
// single source of truth shared with adapter/harness/verification.py.
// Re-exported so existing importers keep resolving them from this module.
//
// Mechanical: exit code / schema / deterministic state inspection — no judgment involved.
// Environmental: inspects already-gathered external observations (evidence, criteria) — real,
//   but can't be reduced to a pass/fail exit code the way mechanical checks can.
// Model: requires semantic judgment (does this genuinely satisfy the goal?) — explicitly out
//   of scope for this mechanical/environmental layer; always SKIPPED here.
export { LAYER_TIER, type LayerTier }

// Required tool per verification layer — matches adapter/harness/verification.py's
// per-function _tool_available() gating (linter, pytest, consistency_checker, etc.)
const LAYER_TO_TOOL: Record<VerificationLayer, string> = {
  syntax: 'linter',
  unit: 'pytest',
  integration: 'integration_runner',
  consistency: 'consistency_checker',
  requirements: 'requirements_checker',
  assumptions: 'assumption_checker',
  goal_correctness: 'goal_checker',
  evidence_sufficiency: 'evidence_checker',
  output_contract_partial: 'contract_checker',
}

function isToolAvailable(tool: string, toolManifest: Record<string, { available: boolean }> | undefined): boolean {
  if (!toolManifest) return true
  const entry = toolManifest[tool]
  if (entry === undefined) return true  // absent = assume available
  return entry.available
}

function skipped(layer: VerificationLayer): LayerResult {
  return { layer, status: 'SKIPPED', detail: `${LAYER_TO_TOOL[layer]} not available` }
}

// Phase 3 of plans/harness_and_assistant_architecture_remediation_plan.html ports Phase 2's
// verification-honesty fix (adapter/harness/verification.py) forward: a layer whose tool is
// nominally "available" no longer fakes a PASS it can't back up. syntax/unit have no TS-side
// execution boundary equivalent to Python's Phase 1b subprocess sandbox (packages/harness runs
// client-side; there is no sandboxed linter/pytest invocation to call here) — so, matching
// Python's own "no target_path → SKIPPED, not a fake PASS" rule, they stay SKIPPED whenever
// there's nothing they can actually run, and now say so honestly instead of assuming PASS the
// moment a tool name happens to be present in the manifest.
function runSyntax(result: unknown, manifest: Record<string, { available: boolean }> | undefined): LayerResult {
  if (!isToolAvailable(LAYER_TO_TOOL.syntax, manifest)) return skipped('syntax')
  if (result === null || result === undefined) {
    return { layer: 'syntax', status: 'FAIL', detail: 'Result is null — syntax check failed' }
  }
  return { layer: 'syntax', status: 'SKIPPED', detail: 'no execution boundary in packages/harness — nothing to lint' }
}

function runUnit(manifest: Record<string, { available: boolean }> | undefined): LayerResult {
  if (!isToolAvailable(LAYER_TO_TOOL.unit, manifest)) return skipped('unit')
  return { layer: 'unit', status: 'SKIPPED', detail: 'no execution boundary in packages/harness — nothing to run' }
}

// Always SKIPPED, regardless of manifest: mirrors verification.py's verify_integration —
// there is no real integration-test runner concept wired up on either side yet; inventing a
// fake pass/fail for a tool that can't actually be invoked would reintroduce the exact
// false-confidence problem this rewrite exists to close.
function runIntegration(): LayerResult {
  return { layer: 'integration', status: 'SKIPPED', detail: 'integration_runner not available' }
}

// Real, deterministic check (no subprocess needed): FAIL if any unresolved HIGH or
// SYSTEM_BREAKING contradiction is present in the world model, PASS otherwise. Mirrors
// verification.py's verify_consistency exactly.
function runConsistency(
  worldModel: WorldModel | null | undefined,
  manifest: Record<string, { available: boolean }> | undefined,
): LayerResult {
  if (!isToolAvailable(LAYER_TO_TOOL.consistency, manifest)) return skipped('consistency')
  if (worldModel === null || worldModel === undefined) {
    return { layer: 'consistency', status: 'SKIPPED', detail: 'no world_model to check against' }
  }
  const unresolved = worldModel.contradictions.filter(c => c.severity === 'HIGH' || c.severity === 'SYSTEM_BREAKING')
  if (unresolved.length > 0) {
    return {
      layer: 'consistency',
      status: 'FAIL',
      detail: `${unresolved.length} unresolved HIGH/SYSTEM_BREAKING contradiction(s) in world model`,
    }
  }
  return { layer: 'consistency', status: 'PASS', detail: 'no unresolved HIGH/SYSTEM_BREAKING contradictions' }
}

// Mechanical-tier limit (mirrors verify_requirements): whether a result *semantically*
// satisfies success_criteria is a model-judgment question this layer can't decide. The one
// mechanically checkable case — criteria were specified but no result was produced at all —
// can FAIL; everything else is an honest SKIPPED, never a PASS this layer can't back up.
function runRequirements(result: unknown, successCriteria: string[], manifest: Record<string, { available: boolean }> | undefined): LayerResult {
  if (!isToolAvailable(LAYER_TO_TOOL.requirements, manifest)) return skipped('requirements')
  if (successCriteria.length === 0) {
    return { layer: 'requirements', status: 'SKIPPED', detail: 'no success criteria to check' }
  }
  if (result === null || result === undefined) {
    return { layer: 'requirements', status: 'FAIL', detail: 'success criteria specified but no result was produced' }
  }
  return {
    layer: 'requirements',
    status: 'SKIPPED',
    detail: 'result produced; semantic satisfaction of criteria requires model-tier judgment, not verified here',
  }
}

// Same mechanical-tier limit as runRequirements (mirrors verify_assumptions).
function runAssumptions(result: unknown, assumptions: string[], manifest: Record<string, { available: boolean }> | undefined): LayerResult {
  if (!isToolAvailable(LAYER_TO_TOOL.assumptions, manifest)) return skipped('assumptions')
  if (assumptions.length === 0) {
    return { layer: 'assumptions', status: 'SKIPPED', detail: 'no assumptions to check' }
  }
  if (result === null || result === undefined) {
    return { layer: 'assumptions', status: 'FAIL', detail: 'assumptions stated but no result was produced' }
  }
  return {
    layer: 'assumptions',
    status: 'SKIPPED',
    detail: 'result produced; environmental validation of assumptions not implemented at this layer',
  }
}

// Model tier by nature (mirrors verify_goal_correctness): "is this the right outcome" is a
// judgment call, not a mechanical property. Always SKIPPED when nominally available — a fake
// PASS here is exactly the false-confidence pattern this rewrite exists to close.
function runGoalCorrectness(manifest: Record<string, { available: boolean }> | undefined): LayerResult {
  if (!isToolAvailable(LAYER_TO_TOOL.goal_correctness, manifest)) return skipped('goal_correctness')
  return {
    layer: 'goal_correctness',
    status: 'SKIPPED',
    detail: 'goal correctness requires model-tier judgment, not implemented at this layer',
  }
}

function runEvidenceSufficiency(
  evidenceStore: EvidenceStore | null,
  scope: 'local' | 'global',
  manifest: Record<string, { available: boolean }> | undefined,
): LayerResult {
  if (!isToolAvailable(LAYER_TO_TOOL.evidence_sufficiency, manifest)) return skipped('evidence_sufficiency')
  if (evidenceStore === null) {
    return { layer: 'evidence_sufficiency', status: 'FAIL', detail: 'No evidence store provided' }
  }
  const entries = evidenceStore.observations

  if (scope === 'global') {
    const qualifying = entries.filter(e => e.reliability === 'HIGH' || e.reliability === 'MEDIUM')
    if (qualifying.length < 5) {
      return {
        layer: 'evidence_sufficiency',
        status: 'FAIL',
        detail: `Global scope needs >= 5 HIGH/MEDIUM evidence items; found ${qualifying.length}`,
      }
    }
  } else {
    if (entries.length < 2) {
      return {
        layer: 'evidence_sufficiency',
        status: 'FAIL',
        detail: `Local scope needs >= 2 evidence items; found ${entries.length}`,
      }
    }
  }
  return { layer: 'evidence_sufficiency', status: 'PASS', detail: 'Evidence sufficiency check passed' }
}

function runOutputContractPartial(
  result: unknown,
  outputContract: OutputContract | null,
  manifest: Record<string, { available: boolean }> | undefined,
): LayerResult {
  if (!isToolAvailable(LAYER_TO_TOOL.output_contract_partial, manifest)) return skipped('output_contract_partial')
  if (outputContract === null) {
    return { layer: 'output_contract_partial', status: 'PASS', detail: 'No output contract to check' }
  }
  const check = contractShadowCheck(result, outputContract)
  if (!check.passed) {
    return {
      layer: 'output_contract_partial',
      status: 'FAIL',
      detail: `Contract violations: ${check.violations.join(', ')}`,
    }
  }
  return { layer: 'output_contract_partial', status: 'PASS', detail: 'Output contract check passed' }
}

function runAdversarialPass(result: unknown, hypothesisSet: HypothesisSet | null): boolean {
  if (hypothesisSet === null) return true
  const active = hypothesisSet.active
  if (active.length === 0) return true

  const topH = active.reduce((best, h) => (h.confidence > best.confidence ? h : best), active[0])
  if (topH.predicted_observations.length === 0) return true
  if (result === null || result === undefined) return false
  if (typeof result === 'object' && (result as Record<string, unknown>)['adversarial_failure']) return false
  return true
}

export function verify(
  result: unknown,
  successCriteria: string[],
  assumptions: string[],
  toolManifest: EvidenceStore | null,
  riskLevel: RiskLevel,
  evidenceStore?: EvidenceStore | null,
  worldModel?: WorldModel | null,
  outputContract?: OutputContract | null,
  hypothesisSet?: HypothesisSet | null,
  scope: 'local' | 'global' = 'local',
): VerificationResult {
  const manifest = toolManifest?.tool_availability_manifest

  // All 9 layers always appear in layer_results — a layer whose tool isn't
  // available is reported as SKIPPED rather than dropped from the array.
  const layer_results: LayerResult[] = [
    runSyntax(result, manifest),
    runUnit(manifest),
    runIntegration(),
    runConsistency(worldModel ?? null, manifest),
    runRequirements(result, successCriteria, manifest),
    runAssumptions(result, assumptions, manifest),
    runGoalCorrectness(manifest),
    runEvidenceSufficiency(evidenceStore ?? null, scope, manifest),
    runOutputContractPartial(result, outputContract ?? null, manifest),
  ]

  const has_critical_failure = layer_results.some(lr => lr.status === 'FAIL')

  let adversarial_passed: boolean | null = null
  if (riskLevel === 'HIGH') {
    adversarial_passed = runAdversarialPass(result, hypothesisSet ?? null)
  }

  return { layer_results, has_critical_failure, adversarial_passed }
}
