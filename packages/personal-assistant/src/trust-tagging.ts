/**
 * Wraps content fetched from the web before it enters the model's context —
 * `read_file`/`list_directory` results are untouched (file content is
 * user-owned, not adversarial-by-default); only web_search/fetch_url results
 * go through this. SYSTEM_PROMPT in assistant.ts carries the matching
 * instruction that content in this tag is data, never instructions.
 */
export function wrapUntrusted(text: string): string {
  return `<untrusted_external_content>\n${text}\n</untrusted_external_content>`
}

interface InjectionPattern {
  pattern: RegExp
  reason: string
}

// A speed bump, not real defense — regex-based, will miss paraphrased attempts
// and can false-positive on benign text that happens to use these phrases.
const INJECTION_PATTERNS: InjectionPattern[] = [
  { pattern: /\bignore (all )?(the )?(previous|prior|above) instructions\b/i, reason: 'asks to ignore prior instructions' },
  { pattern: /\byou are now\b/i, reason: "attempts to redefine the assistant's role" },
  { pattern: /\bnew instructions?:/i, reason: 'presents itself as new instructions' },
  { pattern: /\bsystem prompt\b/i, reason: 'references the system prompt directly' },
  { pattern: /\bdisregard (the |your )?(above|previous)\b/i, reason: 'asks to disregard prior context' },
]

export interface InjectionDetection {
  flagged: boolean
  reason?: string
}

/** Content is always still returned to the model, flagged or not — this only decides whether a warning gets prepended. */
export function detectInjectionLikely(text: string): InjectionDetection {
  for (const { pattern, reason } of INJECTION_PATTERNS) {
    if (pattern.test(text)) return { flagged: true, reason }
  }
  return { flagged: false }
}
