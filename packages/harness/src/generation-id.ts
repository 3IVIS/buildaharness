import type { ControlState } from './state/control-state.js'
import type { WorldModel } from './state/world-model.js'
import type { Diagnostics } from './state/diagnostics.js'
import { FailureDiagnostics } from './state/failure-diagnostics.js'

export interface GateContext {
  subStepA: number
  subStepB: number
}

export class StalenessError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StalenessError'
  }
}

export type ControlStateResolverFn = (
  diagnostics: Diagnostics,
  worldModel: WorldModel,
  failureDiagnostics: FailureDiagnostics,
) => ControlState

export function _maybeResolve(
  controlState: ControlState,
  worldModel: WorldModel,
  diagnostics?: Diagnostics,
  failureDiagnostics?: FailureDiagnostics,
  resolver?: ControlStateResolverFn,
): void {
  if (controlState.generation_id >= worldModel.generation_id) return

  if (!diagnostics || !resolver) {
    throw new StalenessError(
      `ControlState generation_id (${controlState.generation_id}) is stale relative to WorldModel (${worldModel.generation_id})`,
    )
  }

  const fd = failureDiagnostics ?? new FailureDiagnostics()
  const resolved = resolver(diagnostics, worldModel, fd)

  controlState.generation_id = resolved.generation_id
  controlState.risk_state = resolved.risk_state
  controlState.escalation_reason = resolved.escalation_reason
  controlState.block_mask = [...resolved.block_mask]
  controlState.notes = [...resolved.notes]

  if (controlState.generation_id < worldModel.generation_id) {
    throw new StalenessError(
      `ControlState still stale after one resolution attempt (generation_id=${controlState.generation_id}, worldModel.generation_id=${worldModel.generation_id})`,
    )
  }
}

export function computeElevationFactor(subDims: number[]): number {
  if (subDims.length === 0) return 0
  const CAUTION_THRESHOLD = 0.4
  const below = subDims.filter(d => d < CAUTION_THRESHOLD)
  if (below.length === 0) return 0
  const avgDeficit = below.reduce((acc, d) => acc + (CAUTION_THRESHOLD - d), 0) / below.length
  return Math.min(1, avgDeficit / CAUTION_THRESHOLD)
}
