import { harnessLexicalActive } from '../lexical/lexical-off.js'
import { StrategyTypeSchema, type StrategyType } from './strategy-state.js'
import { z } from 'zod'

export const MatchResultSchema = z.object({
  failure_class: z.string(),
  confidence: z.number(),
  matched_pattern: z.string(),
  /** The matched curated entry's preferred recovery strategy, if it named one — see FailureModeEntrySchema.strategy_affinity and rollback-replan.ts's bias. Absent for an entry with none, or a semantic match whose id wasn't found in the library. */
  strategy_affinity: StrategyTypeSchema.optional(),
})
export type MatchResult = z.infer<typeof MatchResultSchema>

export const FailureRecordSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  failure_class: z.string(),
  description: z.string(),
  context: z.record(z.unknown()),
})
export type FailureRecord = z.infer<typeof FailureRecordSchema>

export const FailureModeEntrySchema = z.object({
  id: z.string(),
  failure_class: z.string(),
  symptoms: z.array(z.string()),
  pattern_description: z.string(),
  /**
   * The recovery strategy this failure class responds best to — e.g. a tool being unavailable
   * calls for REIMPLEMENT, not another DIRECT_EDIT attempt. Mirrors adapter/harness/failure_modes.py's
   * FailurePattern.strategy_affinity. Optional so an entry can be diagnostic-only (no lever), and so
   * old persisted entries (from before this field existed) still parse.
   */
  strategy_affinity: StrategyTypeSchema.optional(),
})
export type FailureModeEntry = z.infer<typeof FailureModeEntrySchema>

/**
 * Generic, model-agnostic seed patterns — same 4 failure classes as
 * adapter/harness/failure_modes.py's build_default_library(), re-expressed as short
 * free-text symptom phrases (this class's match() looks for substring containment against
 * observation text, not Python's required-condition keyword set). Curated once here; a fresh
 * run's FailureDiagnostics is seeded with these (see nodes/initialize.ts) so the library has
 * something to match against from the start — a run resumed from an older checkpoint keeps
 * whatever it was persisted with, seeded or not.
 */
export const DEFAULT_FAILURE_MODE_ENTRIES: FailureModeEntry[] = [
  {
    id: 'circular-dependency',
    failure_class: 'CIRCULAR_DEPENDENCY',
    symptoms: ['circular dependency', 'depends on itself', 'dependency cycle', 'blocked on each other'],
    pattern_description: 'Two or more tasks/beliefs depend on each other in a cycle, so nothing can complete first.',
    strategy_affinity: 'BROADER_SEARCH',
  },
  {
    id: 'tool-unavailable-cascade',
    failure_class: 'TOOL_UNAVAILABLE_CASCADE',
    symptoms: ['tool unavailable', 'service unavailable', 'connection refused', 'not available', 'unreachable'],
    pattern_description: 'The same tool (or several) keeps failing to respond — retrying the same call is unlikely to help.',
    strategy_affinity: 'REIMPLEMENT',
  },
  {
    id: 'scope-creep',
    failure_class: 'SCOPE_CREEP',
    symptoms: ['scope expanded', 'grew beyond', 'beyond the original', 'more than originally'],
    pattern_description: "The task's write domain grew across iterations — each attempt takes on more than the last.",
    strategy_affinity: 'MINIMAL_FIX',
  },
  {
    id: 'stale-belief-reliance',
    failure_class: 'STALE_BELIEF_RELIANCE',
    symptoms: ['stale belief', 'outdated information', 'no longer accurate', 'no longer current'],
    pattern_description: "A high-confidence belief the plan relies on is flagged stale — its source may no longer reflect reality.",
    strategy_affinity: 'TRACE_EXEC',
  },
]

export class FailureModeLibrary {
  private entries: FailureModeEntry[]
  class_priors: Record<string, number>

  constructor(entries: FailureModeEntry[] = [], class_priors: Record<string, number> = {}) {
    this.entries = entries
    this.class_priors = class_priors
  }

  /** Read-only view of the curated entries — used by a semantic (e.g. LLM-based) matcher layered on top of this class's own substring-overlap match() (see harness-runtime.ts's semanticFailureMatcher). */
  getEntries(): readonly FailureModeEntry[] {
    return this.entries
  }

  // Curated `symptoms` are short hand-written phrases, but observed `symptoms` passed in here are
  // free-text (e.g. raw error messages) that will almost never equal a curated phrase byte-for-byte —
  // so matching has to look for the curated phrase *within* the free text (or vice versa), case-insensitively.
  // Mirrors adapter/harness/failure_modes.py's FailureModeLibrary.match(), which does the same via
  // substring containment against a joined free-text context blob.
  match(symptoms: string[]): MatchResult | null {
    if (!harnessLexicalActive('failure-exact-match')) return null // HARNESS_LEXICAL_OFF: only a semantic matcher can classify
    let best: MatchResult | null = null
    let bestScore = -1
    for (const entry of this.entries) {
      const overlap = entry.symptoms.filter(curated =>
        curated.length > 0 &&
        symptoms.some(
          s => s.toLowerCase().includes(curated.toLowerCase()) || curated.toLowerCase().includes(s.toLowerCase()),
        ),
      ).length
      if (overlap > 0) {
        const confidence = overlap / Math.max(entry.symptoms.length, symptoms.length)
        if (confidence > bestScore) {
          bestScore = confidence
          best = { failure_class: entry.failure_class, confidence, matched_pattern: entry.id, strategy_affinity: entry.strategy_affinity }
        }
      }
    }
    return best
  }

  toJSON() {
    return { entries: this.entries, class_priors: this.class_priors }
  }
}

/**
 * The semantic matcher only reports `{failure_class, confidence, matched_pattern: <entry id>}` —
 * it has no reason to know about `strategy_affinity`, since that's a property of the curated
 * entry, not something an LLM call about symptom text would invent. Looking the id back up in the
 * library is what lets a semantic match drive rollback-replan.ts's failure-mode bias exactly like
 * an exact match() already does. `undefined` when the id isn't found (a stale/hallucinated id).
 */
export function resolveSemanticMatchStrategy(
  semanticMatch: { matched_pattern: string },
  entries: readonly FailureModeEntry[],
): StrategyType | undefined {
  return entries.find(e => e.id === semanticMatch.matched_pattern)?.strategy_affinity
}

export const FailureDiagnosticsSchema = z.object({
  matched_pattern: MatchResultSchema.nullable(),
  failure_history: z.array(FailureRecordSchema),
  failure_mode_library_data: z.object({
    entries: z.array(FailureModeEntrySchema),
    class_priors: z.record(z.number()),
  }),
})
export type FailureDiagnosticsData = z.infer<typeof FailureDiagnosticsSchema>

export class FailureDiagnostics {
  readonly failure_mode_library: FailureModeLibrary
  matched_pattern: MatchResult | null
  failure_history: FailureRecord[]

  constructor(data?: Partial<{
    failure_mode_library: FailureModeLibrary
    matched_pattern: MatchResult | null
    failure_history: FailureRecord[]
  }>) {
    this.failure_mode_library = data?.failure_mode_library ?? new FailureModeLibrary()
    this.matched_pattern = data?.matched_pattern ?? null
    this.failure_history = data?.failure_history ?? []
  }

  recordFailure(record: FailureRecord): void {
    this.failure_history.push(record)
  }

  toJSON(): FailureDiagnosticsData {
    return {
      matched_pattern: this.matched_pattern,
      failure_history: this.failure_history,
      failure_mode_library_data: this.failure_mode_library.toJSON(),
    }
  }

  static fromJSON(json: FailureDiagnosticsData): FailureDiagnostics {
    const parsed = FailureDiagnosticsSchema.parse(json)
    const library = new FailureModeLibrary(
      parsed.failure_mode_library_data.entries,
      parsed.failure_mode_library_data.class_priors,
    )
    return new FailureDiagnostics({
      failure_mode_library: library,
      matched_pattern: parsed.matched_pattern,
      failure_history: parsed.failure_history,
    })
  }
}
