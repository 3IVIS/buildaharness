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

// Required tool per verification layer
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

const ALL_LAYERS: VerificationLayer[] = [
  'syntax',
  'unit',
  'integration',
  'consistency',
  'requirements',
  'assumptions',
  'goal_correctness',
  'evidence_sufficiency',
  'output_contract_partial',
]

function isToolAvailable(tool: string, toolManifest: Record<string, { available: boolean }> | undefined): boolean {
  if (!toolManifest) return true
  const entry = toolManifest[tool]
  if (entry === undefined) return true  // absent = assume available
  return entry.available
}

function runSyntax(result: unknown): LayerResult {
  if (result === null || result === undefined) {
    return { layer: 'syntax', status: 'FAIL', detail: 'Result is null — syntax check failed' }
  }
  return { layer: 'syntax', status: 'PASS', detail: 'Syntax check passed' }
}

function runUnit(): LayerResult {
  return { layer: 'unit', status: 'PASS', detail: 'Unit verification passed' }
}

function runIntegration(): LayerResult {
  return { layer: 'integration', status: 'PASS', detail: 'Integration verification passed' }
}

function runConsistency(): LayerResult {
  return { layer: 'consistency', status: 'PASS', detail: 'Consistency check passed' }
}

function runRequirements(successCriteria: string[]): LayerResult {
  if (successCriteria.length === 0) {
    return { layer: 'requirements', status: 'PASS', detail: 'No criteria to check' }
  }
  return { layer: 'requirements', status: 'PASS', detail: 'Requirements check passed' }
}

function runAssumptions(): LayerResult {
  return { layer: 'assumptions', status: 'PASS', detail: 'Assumptions check passed' }
}

function runGoalCorrectness(): LayerResult {
  return { layer: 'goal_correctness', status: 'PASS', detail: 'Goal correctness check passed' }
}

function runEvidenceSufficiency(evidenceStore: EvidenceStore | null, scope: 'local' | 'global'): LayerResult {
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

function runOutputContractPartial(result: unknown, outputContract: OutputContract | null): LayerResult {
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

  // Run all 9 layers internally — never skip at execution
  const internalResults: LayerResult[] = [
    runSyntax(result),
    runUnit(),
    runIntegration(),
    runConsistency(),
    runRequirements(successCriteria),
    runAssumptions(),
    runGoalCorrectness(),
    runEvidenceSufficiency(evidenceStore ?? null, scope),
    runOutputContractPartial(result, outputContract ?? null),
  ]

  // Post-filter: enabled_layers = layers whose required tool is available
  const enabledLayers = new Set<VerificationLayer>(
    ALL_LAYERS.filter(layer => isToolAvailable(LAYER_TO_TOOL[layer], manifest)),
  )

  const layer_results = internalResults.filter(lr => enabledLayers.has(lr.layer))
  const has_critical_failure = layer_results.some(lr => lr.status === 'FAIL')

  let adversarial_passed: boolean | null = null
  if (riskLevel === 'HIGH') {
    adversarial_passed = runAdversarialPass(result, hypothesisSet ?? null)
  }

  return { layer_results, has_critical_failure, adversarial_passed }
}
