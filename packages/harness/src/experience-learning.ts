import type { ExperienceStore } from './state/experience-store.js'
import type { JournalEntry } from './state/memory-state.js'
import {
  decidePromotion,
  recordAttempt,
  MIN_ATTEMPTS,
  type StrategyEvent,
  type StrategyEvidence,
} from './strategy-evidence.js'
import { DEFAULT_STRATEGY_ORDER, type StrategyType } from './state/strategy-state.js'

/**
 * Cross-run learning for the harness — the feed that `warmStart` and `buildStrategyOrdering` were written to read.
 *
 * Both consumers existed long before anything wrote to the store: `getStrategyWeights()` / `getClassPriors()` were `{}` in
 * practice, so the recovery ladder never left its default order and the reviewer's "high prior for failure class" finding could
 * never fire. This is the missing half, opt-in (`HarnessRunOptions.experienceLearning`):
 *
 *  1. Every executed task appends a journal entry (`journalEntryFor`): the strategy in effect, the outcome, and — for a failure —
 *     the failure class, in the form `failed:<class>` (an unmatched failure has the empty class, exactly the key
 *     `buildStrategyOrdering` looks up for it).
 *  2. When the run ends, `learnFromJournal` reads the journal back. An entry that FOLLOWS a failure is a recovery attempt: the
 *     ladder switched strategy in answer to that failure, so the strategy in effect for the next executed task was tried against
 *     class X, and it worked (the entry succeeded) or it did not. The strategy is run-global, so the credit goes to it even when
 *     the next task is a different one (a rebuilt task, or a sibling) — an approximation, and the one the ladder's own switching
 *     implies. That moves `strategyWeights["S:X"]` toward 1 or 0. Failure-class priors move toward 1 for a class seen this run and toward
 *     0 for one not seen.
 *
 * Weights are an exponential moving average, so they stay in [0,1] and a run's evidence counts for `LEARNING_RATE` of the
 * total. The first time a class is learned about, EVERY strategy's weight for it is initialised to `PRIOR` — otherwise an untried
 * strategy (weight 0) would rank below one that had already failed (0.2), and the ladder would stop exploring.
 */
export const LEARNING_RATE = 0.3
export const PRIOR = 0.5
const FAILED_PREFIX = 'failed:'

const round = (n: number): number => Math.round(n * 10000) / 10000

/** The journal entry for one executed task. `failureClass` is the class of a failure ('' if unmatched); absent means it succeeded. */
export function journalEntryFor(input: {
  step: number
  strategy: StrategyType
  success: boolean
  failureClass?: string
  output?: unknown
}): JournalEntry {
  const verbatim = typeof input.output === 'string' ? input.output.slice(0, 500) : undefined
  return {
    step: input.step,
    action_class: input.strategy,
    outcome: input.success ? 'completed' : `${FAILED_PREFIX}${input.failureClass ?? ''}`,
    success: input.success,
    ...(input.success && verbatim ? { verbatim } : {}),
  }
}

/** The failure class a journal entry recorded, or null if it did not fail. */
export function failureClassOf(entry: JournalEntry): string | null {
  return !entry.success && entry.outcome.startsWith(FAILED_PREFIX) ? entry.outcome.slice(FAILED_PREFIX.length) : null
}

export interface RecoveryAttempt {
  strategy: StrategyType
  failureClass: string
  success: boolean
}

/** Every entry that came directly after a failure, paired with the class of the failure it answered. */
export function recoveryAttempts(journal: JournalEntry[]): RecoveryAttempt[] {
  const strategies = DEFAULT_STRATEGY_ORDER as readonly string[]
  const attempts: RecoveryAttempt[] = []
  const ordered = [...journal].sort((a, b) => a.step - b.step)
  for (let i = 1; i < ordered.length; i++) {
    const answered = failureClassOf(ordered[i - 1])
    if (answered !== null && strategies.includes(ordered[i].action_class)) {
      attempts.push({ strategy: ordered[i].action_class as StrategyType, failureClass: answered, success: ordered[i].success })
    }
  }
  return attempts
}

export interface LearnOptions {
  /**
   * `single` (default, the legacy rule): one success moves the weight. `sample`: attempts are recorded as evidence and the weight
   * is written only once the strategy has `minAttempts` and a Wilson lower bound above its alternatives' baseline; otherwise it
   * is "recorded, not used". A strategy that falls below the bar (or hits a failure streak) is demoted back to unused (weight 0).
   */
  rule?: 'single' | 'sample'
  minAttempts?: number
  runId?: string
  /** Context fingerprint (tool set, model, task family). Evidence from another context starts over. */
  context?: string
  now?: number
  /** Receives a `strategy_promoted` / `strategy_demoted` event with the numbers that justified it. */
  onEvent?: (event: StrategyEvent) => void
}

/** Updates the store from one finished run's journal. A no-op on an unavailable store or an empty journal. */
export function learnFromJournal(journal: JournalEntry[], store: ExperienceStore, options: LearnOptions = {}): void {
  if (!store.available || journal.length === 0) return

  const weights = store.getStrategyWeights()
  if (options.rule === 'sample') {
    learnWithSampleRule(journal, store, weights, options)
  } else {
    for (const a of recoveryAttempts(journal)) {
      const key = (s: string) => `${s}:${a.failureClass}`
      if (DEFAULT_STRATEGY_ORDER.every((s) => weights[key(s)] === undefined)) {
        for (const s of DEFAULT_STRATEGY_ORDER) {
          weights[key(s)] = PRIOR
          store.setStrategyWeight(key(s), PRIOR)
        }
      }
      const next = round((weights[key(a.strategy)] ?? PRIOR) * (1 - LEARNING_RATE) + (a.success ? 1 : 0) * LEARNING_RATE)
      weights[key(a.strategy)] = next
      store.setStrategyWeight(key(a.strategy), next)
    }
  }

  const seen = new Set<string>()
  for (const e of journal) {
    const c = failureClassOf(e)
    if (c !== null && c !== '') seen.add(c)
  }
  const priors = store.getClassPriors()
  for (const c of new Set([...Object.keys(priors), ...seen])) {
    store.setClassPrior(c, round((priors[c] ?? 0) * (1 - LEARNING_RATE) + (seen.has(c) ? 1 : 0) * LEARNING_RATE))
  }
}

function learnWithSampleRule(
  journal: JournalEntry[],
  store: ExperienceStore,
  weights: Record<string, number>,
  options: LearnOptions,
): void {
  const evidence: Record<string, StrategyEvidence> = store.getStrategyEvidence()
  const touched = new Set<string>()
  const now = options.now ?? Date.now()
  for (const a of recoveryAttempts(journal)) {
    const key = `${a.strategy}:${a.failureClass}`
    evidence[key] = recordAttempt(evidence[key], { success: a.success, runId: options.runId, now, context: options.context ?? '' })
    touched.add(key)
  }
  for (const key of touched) {
    const cls = key.slice(key.indexOf(':') + 1)
    const others = DEFAULT_STRATEGY_ORDER.filter((s) => `${s}:${cls}` !== key)
      .map((s) => evidence[`${s}:${cls}`])
      .filter((e): e is StrategyEvidence => e !== undefined)
    const entry = evidence[key]
    const decision = decidePromotion(entry, others, options.minAttempts ?? MIN_ATTEMPTS)
    const wasPromoted = entry.promoted
    entry.promoted = decision.promoted
    store.setStrategyEvidence(key, entry)
    if (decision.promoted) {
      const weight = round(entry.weightedSuccesses / entry.weightedAttempts)
      weights[key] = weight
      store.setStrategyWeight(key, weight)
    } else if (wasPromoted) {
      weights[key] = 0
      store.setStrategyWeight(key, 0)
    }
    if (decision.promoted !== wasPromoted) {
      options.onEvent?.({
        type: decision.promoted ? 'strategy_promoted' : 'strategy_demoted',
        key,
        attempts: entry.attempts,
        successes: entry.successes,
        lowerBound: decision.lowerBound,
        baseline: decision.baseline,
        ...(options.runId ? { runId: options.runId } : {}),
      })
    }
  }
}
