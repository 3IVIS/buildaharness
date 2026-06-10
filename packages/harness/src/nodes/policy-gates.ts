import type { WorldModel } from '../state/world-model.js'
import type { Diagnostics } from '../state/diagnostics.js'
import type { FailureDiagnostics } from '../state/failure-diagnostics.js'
import type { OutputContract } from '../state/output-contract.js'
import { ControlState } from '../state/control-state.js'
import { _maybeResolve, type ControlStateResolverFn } from '../generation-id.js'

export type ActionGateResult = 'PASS' | 'BLOCK' | 'ESCALATE'

export interface GatedAction {
  required_resources?: string[]
}

export interface VerificationSummary {
  has_critical_failure: boolean
}

export interface ContractShadowCheckResult {
  passed: boolean
  violations: string[]
}

export function contractShadowCheck(
  result: unknown,
  outputContract: OutputContract | null,
): ContractShadowCheckResult {
  if (outputContract === null) return { passed: true, violations: [] }

  const violations: string[] = []

  if (typeof result === 'object' && result !== null) {
    for (const section of outputContract.required_sections) {
      if (!(section in (result as Record<string, unknown>))) {
        violations.push(`Missing required field: ${section}`)
      }
    }
  }

  return { passed: violations.length === 0, violations }
}

export function actionGate(
  action: GatedAction | null,
  controlState: ControlState,
  worldModel: WorldModel,
  diagnostics?: Diagnostics,
  failureDiagnostics?: FailureDiagnostics,
  resolver?: ControlStateResolverFn,
): ActionGateResult {
  _maybeResolve(controlState, worldModel, diagnostics, failureDiagnostics, resolver)

  // ESCALATE immediately on HUMAN_REQUIRED without evaluating block_mask
  if (controlState.escalation_reason === 'HUMAN_REQUIRED') return 'ESCALATE'

  if (controlState.risk_state === 'BLOCKED') return 'BLOCK'

  if (controlState.block_mask.length > 0 && action !== null) {
    const blockedSet = new Set(controlState.block_mask)
    const required = new Set(action.required_resources ?? [])
    for (const r of required) {
      if (blockedSet.has(r)) return 'BLOCK'
    }
  }

  return 'PASS'
}

export function postExecGate(
  result: unknown,
  verification: VerificationSummary,
  controlState: ControlState,
  worldModel: WorldModel,
  diagnostics?: Diagnostics,
  failureDiagnostics?: FailureDiagnostics,
  outputContract?: OutputContract | null,
  resolver?: ControlStateResolverFn,
): boolean {
  _maybeResolve(controlState, worldModel, diagnostics, failureDiagnostics, resolver)

  if (outputContract !== undefined && outputContract !== null) {
    const check = contractShadowCheck(result, outputContract)
    if (!check.passed) return false
  }

  if (verification.has_critical_failure) return false

  return true
}
