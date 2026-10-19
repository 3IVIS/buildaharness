/**
 * Evidence behind a learned recovery strategy (memory observability plan, X1).
 *
 * A strategy is a bet about what works, not a fact. The legacy rule ("one success moves the weight") can promote a strategy on
 * a single lucky run. The sample rule records the evidence and lets a strategy influence ordering only once it has a minimum
 * number of attempts AND a Wilson lower bound above the baseline success rate of the alternatives it would displace. Below that
 * it is "recorded, not used": the entry exists and can be shown, the weight consumers read stays untouched.
 */

/** Evidence for one `${strategy}:${failureClass}` key. */
export interface StrategyEvidence {
  attempts: number
  successes: number
  /** Exponentially decayed counts: recent attempts weigh more. Used for the promotion bound. */
  weightedAttempts: number
  weightedSuccesses: number
  lastUsedAt: number
  /** Context fingerprint (tool set, model, task family) the attempts were observed in. */
  context: string
  /** Latest outcomes, newest last, bounded to `RECENT_WINDOW`. */
  recent: boolean[]
  /** Bounded list of run ids that contributed, so a number can be traced to runs. */
  runIds: string[]
  promoted: boolean
}

export const MIN_ATTEMPTS = 5
export const DECAY = 0.9
export const RECENT_WINDOW = 10
export const MAX_RUN_REFS = 20
/** Baseline when no alternative has any evidence: a coin flip. */
export const DEFAULT_BASELINE = 0.5
/** This many failures in a row demote a promoted strategy. */
export const DEMOTION_STREAK = 3

const Z = 1.96
const round = (n: number): number => Math.round(n * 10000) / 10000

/** Lower bound of the Wilson score interval (95%) for `successes` of `n`. 0 when n is 0. */
export function wilsonLowerBound(successes: number, n: number): number {
  if (n <= 0) return 0
  const p = Math.min(1, Math.max(0, successes / n))
  const z2 = Z * Z
  const centre = p + z2 / (2 * n)
  const margin = Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))
  return Math.max(0, (centre - margin) / (1 + z2 / n))
}

export function emptyEvidence(context: string): StrategyEvidence {
  return { attempts: 0, successes: 0, weightedAttempts: 0, weightedSuccesses: 0, lastUsedAt: 0, context, recent: [], runIds: [], promoted: false }
}

/** Returns a new evidence record with one attempt folded in. A different context starts a fresh record (scope, not universality). */
export function recordAttempt(
  prior: StrategyEvidence | undefined,
  input: { success: boolean; runId?: string; now: number; context: string },
): StrategyEvidence {
  const base = prior && prior.context === input.context ? prior : emptyEvidence(input.context)
  const runIds = input.runId && !base.runIds.includes(input.runId) ? [...base.runIds, input.runId] : [...base.runIds]
  return {
    attempts: base.attempts + 1,
    successes: base.successes + (input.success ? 1 : 0),
    weightedAttempts: round(base.weightedAttempts * DECAY + 1),
    weightedSuccesses: round(base.weightedSuccesses * DECAY + (input.success ? 1 : 0)),
    lastUsedAt: input.now,
    context: input.context,
    recent: [...base.recent, input.success].slice(-RECENT_WINDOW),
    runIds: runIds.slice(-MAX_RUN_REFS),
    promoted: base.promoted,
  }
}

/** Success rate of the alternatives: the pooled (decayed) rate of every other strategy for the same class, or the default. */
export function baselineFor(others: StrategyEvidence[]): number {
  const n = others.reduce((a, e) => a + e.weightedAttempts, 0)
  if (n <= 0) return DEFAULT_BASELINE
  return others.reduce((a, e) => a + e.weightedSuccesses, 0) / n
}

export interface PromotionDecision {
  promoted: boolean
  lowerBound: number
  baseline: number
  attempts: number
}

/** Whether a strategy may influence ordering: enough attempts and a lower bound above the baseline; a failure streak demotes. */
export function decidePromotion(e: StrategyEvidence, others: StrategyEvidence[], minAttempts = MIN_ATTEMPTS): PromotionDecision {
  const baseline = baselineFor(others)
  const lowerBound = wilsonLowerBound(e.weightedSuccesses, e.weightedAttempts)
  const streak = e.recent.length >= DEMOTION_STREAK && e.recent.slice(-DEMOTION_STREAK).every((s) => !s)
  const promoted = e.attempts >= minAttempts && lowerBound > baseline && !streak
  return { promoted, lowerBound: round(lowerBound), baseline: round(baseline), attempts: e.attempts }
}

export interface StrategyEvent {
  type: 'strategy_promoted' | 'strategy_demoted'
  key: string
  attempts: number
  successes: number
  lowerBound: number
  baseline: number
  runId?: string
}
