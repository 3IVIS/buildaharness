import type { TurnComplexitySignal } from './harness-runtime.js'

/**
 * AL5a of the adaptive layer selection plan. `TurnSignals` generalises `TurnComplexitySignal`
 * (kept as a compatible subset — every field of the old signal is still here, unchanged) with the
 * user-input signals the consolidated turn classifier emits in its existing single call (AL-7: no
 * new per-turn LLM call), plus run-state features computed from state rather than language.
 * Every added field is optional and read by nothing yet — AL7's `LayerPolicy` is the consumer —
 * so a caller that ignores them gets byte-identical behaviour (AL-2).
 */
export type TurnAmbiguity = 'none' | 'some' | 'high' | 'unknown'
export type TurnUserPosture = 'informational' | 'directive' | 'exploratory' | 'corrective' | 'unknown'

/** What a tool does to the world, independent of how it is named or what the user said. */
export type ToolEffectClass = 'read' | 'write' | 'execute' | 'network'

export type Trend = 'improving' | 'flat' | 'degrading' | 'unknown'

/** State-derived features (never language-derived) the layer policy reads. */
export interface RunState {
  consecutiveFailures: number
  turnDepth: number
  cumulativeSpend: number
  /** null when the session has no budget. */
  sessionBudget: number | null
  diagnosticsTrend: Trend
  verificationTrend: Trend
  /** tool name → success rate in [0,1]; absent when a tool has no history. */
  toolReliability: Record<string, number>
  untrustedContentInContext: boolean
}

export interface TurnSignals extends TurnComplexitySignal {
  /** Tools actually exercised this turn — the pre-AL5a meaning of `consequentialTools`, still what drives the evidence-escalation gate. */
  exercisedTools?: Set<string>
  /** The turn classifier's conservative triviality verdict — the input to today's FAST / full split (AL7b). */
  isTrivial?: boolean
  needsGrounding?: boolean
  ambiguity?: TurnAmbiguity
  userPosture?: TurnUserPosture
  pushbackOnPriorTurn?: boolean
  statesConstraint?: boolean
  runState?: RunState
}

const CONSEQUENTIAL_EFFECTS: ReadonlySet<ToolEffectClass> = new Set(['write', 'execute'])

/**
 * The tools a turn may invoke whose effect class mutates the world (write / execute). `network`
 * here means outbound read-only egress (search, fetch) and is not consequential. A tool absent
 * from the manifest is treated as consequential — an unknown effect is not verified-safe.
 */
export function deriveConsequentialTools(toolNames: Iterable<string>, manifest: Record<string, ToolEffectClass>): Set<string> {
  const out = new Set<string>()
  for (const name of toolNames) {
    const effect = manifest[name]
    if (effect === undefined || CONSEQUENTIAL_EFFECTS.has(effect)) out.add(name)
  }
  return out
}

/** Compares the mean of the later half of a series to the earlier half; higher-is-better unless `lowerIsBetter`. */
export function computeTrend(series: number[], lowerIsBetter = false, epsilon = 0.05): Trend {
  if (series.length < 2) return 'unknown'
  const mid = Math.floor(series.length / 2)
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
  const delta = mean(series.slice(mid)) - mean(series.slice(0, mid))
  if (Math.abs(delta) <= epsilon) return 'flat'
  return (delta > 0) !== lowerIsBetter ? 'improving' : 'degrading'
}

export interface RunStateInput {
  /** Outcomes in order, oldest first; true = failure. */
  outcomes?: boolean[]
  turnDepth?: number
  cumulativeSpend?: number
  sessionBudget?: number | null
  /** Per-iteration health scores (higher is better), oldest first. */
  diagnosticsScores?: number[]
  verificationScores?: number[]
  toolReliability?: Record<string, number>
  untrustedContentInContext?: boolean
}

export function computeRunState(input: RunStateInput = {}): RunState {
  let consecutiveFailures = 0
  const outcomes = input.outcomes ?? []
  for (let i = outcomes.length - 1; i >= 0 && outcomes[i]; i--) consecutiveFailures++
  return {
    consecutiveFailures,
    turnDepth: input.turnDepth ?? 0,
    cumulativeSpend: input.cumulativeSpend ?? 0,
    sessionBudget: input.sessionBudget ?? null,
    diagnosticsTrend: computeTrend(input.diagnosticsScores ?? []),
    verificationTrend: computeTrend(input.verificationScores ?? []),
    toolReliability: { ...(input.toolReliability ?? {}) },
    untrustedContentInContext: input.untrustedContentInContext ?? false,
  }
}
