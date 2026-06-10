import type { WorldModel } from '../state/world-model.js'
import type { Diagnostics } from '../state/diagnostics.js'
import type { HypothesisSet } from '../state/hypothesis-set.js'
import type { ToolAvailability } from '../state/evidence-store.js'
import { normalise, DimensionType } from '../normalise.js'

export type ToolAvailabilityManifest = Record<string, ToolAvailability>

export interface VOIResult {
  voi: number
  should_gather_evidence: boolean
  adequacy_shortfall: number
  adequacy_unresolvable: boolean
  updated_verification_strength: number | null
}

const LOW_ADEQUACY_THRESHOLD = 0.3
const HIGH_VOI_THRESHOLD = 0.5

export function estimateVOI(
  diagnostics: Diagnostics,
  _worldModel: WorldModel,
  hypothesisSet: HypothesisSet,
  toolAvailabilityManifest: ToolAvailabilityManifest,
): VOIResult {
  // VOI = expected_uncertainty_reduction × decision_impact
  const activeCount = hypothesisSet.active.length
  const expectedUncertaintyReduction = activeCount > 1 ? (activeCount - 1) / activeCount : 0
  const decisionImpact = 1 - diagnostics.verification_health.strength
  const voi = normalise(expectedUncertaintyReduction * decisionImpact, DimensionType.ratio)

  // verification_adequacy_critic: assess available tool coverage
  const tools = Object.values(toolAvailabilityManifest)
  const availableCount = tools.filter(t => t.available).length
  const adequacy = tools.length === 0 ? 1 : availableCount / tools.length

  const adequacy_shortfall = Math.max(0, LOW_ADEQUACY_THRESHOLD - adequacy)
  const should_gather_evidence = voi > HIGH_VOI_THRESHOLD || adequacy < LOW_ADEQUACY_THRESHOLD

  // Unresolvable: no available tools and no fallbacks to rescue adequacy
  const hasAnyFallback = tools.some(t => !t.available && t.fallback_tool !== null)
  const adequacy_unresolvable = adequacy < LOW_ADEQUACY_THRESHOLD && !hasAnyFallback && availableCount === 0

  let updated_verification_strength: number | null = null
  if (adequacy_unresolvable) {
    // Shortfall updates verification_health.strength → feeds next resolveControlState() TIER 2
    updated_verification_strength = normalise(adequacy, DimensionType.ratio)
    diagnostics.verification_health.strength = updated_verification_strength
  }

  return {
    voi,
    should_gather_evidence,
    adequacy_shortfall,
    adequacy_unresolvable,
    updated_verification_strength,
  }
}
