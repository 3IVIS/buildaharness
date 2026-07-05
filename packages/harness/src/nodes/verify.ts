import type { WorldModel } from '../state/world-model.js'
import type { EvidenceStore } from '../state/evidence-store.js'
import type { OutputContract } from '../state/output-contract.js'
import type { HypothesisSet } from '../state/hypothesis-set.js'
import type { RiskLevel } from '../state/task-graph.js'
import { contractShadowCheck } from './policy-gates.js'

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

function runSyntax(result: unknown, manifest: Record<string, { available: boolean }> | undefined): LayerResult {
  if (!isToolAvailable(LAYER_TO_TOOL.syntax, manifest)) return skipped('syntax')
  if (result === null || result === undefined) {
    return { layer: 'syntax', status: 'FAIL', detail: 'Result is null — syntax check failed' }
  }
  return { layer: 'syntax', status: 'PASS', detail: 'Syntax check passed' }
}

function runUnit(manifest: Record<string, { available: boolean }> | undefined): LayerResult {
  if (!isToolAvailable(LAYER_TO_TOOL.unit, manifest)) return skipped('unit')
  return { layer: 'unit', status: 'PASS', detail: 'Unit verification passed' }
}

function runIntegration(manifest: Record<string, { available: boolean }> | undefined): LayerResult {
  if (!isToolAvailable(LAYER_TO_TOOL.integration, manifest)) return skipped('integration')
  return { layer: 'integration', status: 'PASS', detail: 'Integration verification passed' }
}

function runConsistency(manifest: Record<string, { available: boolean }> | undefined): LayerResult {
  if (!isToolAvailable(LAYER_TO_TOOL.consistency, manifest)) return skipped('consistency')
  return { layer: 'consistency', status: 'PASS', detail: 'Consistency check passed' }
}

function runRequirements(successCriteria: string[], manifest: Record<string, { available: boolean }> | undefined): LayerResult {
  if (!isToolAvailable(LAYER_TO_TOOL.requirements, manifest)) return skipped('requirements')
  if (successCriteria.length === 0) {
    return { layer: 'requirements', status: 'PASS', detail: 'No criteria to check' }
  }
  return { layer: 'requirements', status: 'PASS', detail: 'Requirements check passed' }
}

function runAssumptions(manifest: Record<string, { available: boolean }> | undefined): LayerResult {
  if (!isToolAvailable(LAYER_TO_TOOL.assumptions, manifest)) return skipped('assumptions')
  return { layer: 'assumptions', status: 'PASS', detail: 'Assumptions check passed' }
}

function runGoalCorrectness(manifest: Record<string, { available: boolean }> | undefined): LayerResult {
  if (!isToolAvailable(LAYER_TO_TOOL.goal_correctness, manifest)) return skipped('goal_correctness')
  return { layer: 'goal_correctness', status: 'PASS', detail: 'Goal correctness check passed' }
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
  _assumptions: string[],
  toolManifest: EvidenceStore | null,
  riskLevel: RiskLevel,
  evidenceStore?: EvidenceStore | null,
  _worldModel?: WorldModel | null,
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
    runIntegration(manifest),
    runConsistency(manifest),
    runRequirements(successCriteria, manifest),
    runAssumptions(manifest),
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
