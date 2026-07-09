import { z } from 'zod'

export const MatchResultSchema = z.object({
  failure_class: z.string(),
  confidence: z.number(),
  matched_pattern: z.string(),
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
})
export type FailureModeEntry = z.infer<typeof FailureModeEntrySchema>

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
          best = { failure_class: entry.failure_class, confidence, matched_pattern: entry.id }
        }
      }
    }
    return best
  }

  toJSON() {
    return { entries: this.entries, class_priors: this.class_priors }
  }
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
