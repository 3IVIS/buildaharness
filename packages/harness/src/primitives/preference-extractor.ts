/**
 * G-3 — FeedbackPreferenceExtractor
 *
 * Parses free-text feedback into structured preference updates via
 * configurable keyword-to-field signal mappings.
 * Port of adapter/harness/preference_extractor.py. No domain vocabulary.
 */

export interface PreferenceSignal {
  patterns: string[]
  field: string
  value?: unknown
  delta?: number
  minValue?: number
  maxValue?: number
}

export function makePreferenceExtractor(
  signals: PreferenceSignal[],
  options?: {
    inputKey?: string
    outputKey?: string
    processedFlagKey?: string
  },
): (state: Record<string, unknown>) => Record<string, unknown> {
  for (const signal of signals) {
    if (signal.value != null && signal.delta != null) {
      throw new Error('PreferenceSignal: value and delta are mutually exclusive')
    }
  }

  const inputKey = options?.inputKey ?? 'feedback_text'
  const outputKey = options?.outputKey ?? 'preference_updates'
  const processedFlagKey = options?.processedFlagKey ?? 'feedback_processed'

  return function extract(state: Record<string, unknown>): Record<string, unknown> {
    const text = state[inputKey]
    if (!text) return state

    const lowerText = (text as string).toLowerCase()
    const updates: Record<string, unknown> = {}

    for (const signal of signals) {
      if (signal.patterns.some((p) => lowerText.includes(p.toLowerCase()))) {
        if (signal.delta != null) {
          const base = (state[signal.field] as number) ?? 0
          let newVal = base + signal.delta
          if (signal.minValue !== undefined) newVal = Math.max(signal.minValue, newVal)
          if (signal.maxValue !== undefined) newVal = Math.min(signal.maxValue, newVal)
          updates[signal.field] = newVal
        } else {
          updates[signal.field] = signal.value
        }
      }
    }

    return { ...state, [outputKey]: updates, [processedFlagKey]: true }
  }
}
