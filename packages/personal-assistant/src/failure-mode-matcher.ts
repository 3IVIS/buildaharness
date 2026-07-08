import type { ILLMClient, TokenUsage } from '@buildaharness/runtime'
import type { FailureModeEntry } from '@buildaharness/harness'

const MATCH_SCHEMA = {
  type: 'object',
  properties: {
    matched: { type: 'boolean' },
    failure_class: { type: 'string' },
    matched_pattern: { type: 'string' },
    confidence: { type: 'number' },
  },
  required: ['matched'],
}

const SYSTEM_PROMPT =
  'You match a set of observed symptoms against a curated library of known failure patterns — ' +
  'not by exact wording, but by meaning (e.g. "the request took too long and timed out" matches ' +
  'a curated symptom of "request timed out"). You are given "symptoms" (free-text observations) ' +
  'and "libraryEntries" (each with an id, failure_class, curated symptoms, and a description) as ' +
  'JSON. If one entry\'s pattern genuinely matches, respond with JSON only: {"matched": true, ' +
  '"failure_class": string, "matched_pattern": entry id, "confidence": number between 0 and 1}. ' +
  'If none genuinely match, respond {"matched": false}. Do not force a match onto an unrelated pattern.'

/**
 * One LLM call checking a symptom set against the whole failure-mode library at once (never
 * one call per entry) — layered on top of FailureModeLibrary.match()'s own exact-string-overlap
 * check, which requires a symptom to be byte-for-byte identical to a curated one. Since
 * observations are free text ("Task executed: ...", "Result: ..."), exact equality against a
 * curated list almost never happens by chance — this is what actually lets the library
 * recognize a known failure pattern described in different words. Falls back to "no match" on
 * any parse failure or LLM error, matching this codebase's other LLM-backed classifiers — a
 * missed match costs nothing worse than the exact-match-only behavior this is layered on top of.
 */
export async function checkSemanticFailureMatch(
  symptoms: string[],
  libraryEntries: readonly FailureModeEntry[],
  llmClient: ILLMClient,
  model?: string,
  onUsage?: (usage: TokenUsage) => void,
): Promise<{ failure_class: string; confidence: number; matched_pattern: string } | null> {
  if (symptoms.length === 0 || libraryEntries.length === 0) return null

  try {
    const response = await llmClient.callChatStructured(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify({ symptoms, libraryEntries }) },
      ],
      undefined,
      { model, onUsage, structuredOutput: { schema: MATCH_SCHEMA } },
    )
    const parsed = JSON.parse(response.content) as {
      matched?: unknown
      failure_class?: unknown
      matched_pattern?: unknown
      confidence?: unknown
    }
    if (parsed.matched !== true) return null
    if (typeof parsed.failure_class !== 'string' || typeof parsed.matched_pattern !== 'string') return null
    const confidence = typeof parsed.confidence === 'number' ? Math.min(1, Math.max(0, parsed.confidence)) : 0.5
    return { failure_class: parsed.failure_class, matched_pattern: parsed.matched_pattern, confidence }
  } catch {
    return null
  }
}
