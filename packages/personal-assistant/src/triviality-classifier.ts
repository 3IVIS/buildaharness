import type { RiskLevel } from './risk-classifier.js'

export interface TrivialityClassification {
  isTrivial: boolean
  reason: string
}

const WORD_LIMIT = 15

// Any of these disqualify triviality outright — fail closed toward running
// the full harness whenever the request isn't unambiguously a one-shot fact.
const HISTORY_MARKERS = /\b(earlier|before|you said|remember|again|previously|as I mentioned|still)\b/i
const GENERATIVE_MARKERS = /\b(write|draft|give me a|create|generate|compose|plan|design|pitch|summarize|explain|compare|pros and cons|recommend|best way|should I|how do I decide)\b/i
const COMPOUND_MARKERS = /\band also\b|\?.*\?/

// A trivial candidate must additionally look like a single, self-contained
// factual question — not a fixed topic list (timezone, unit conversion, ...),
// just a shape: opens with an interrogative, short enough to be one fact.
const FACTUAL_SHAPE = /^(what|when|where|how many|how much|is|are|does|do)\b/i

/**
 * Deliberately conservative: default is "not trivial" (run the full harness).
 * Only a narrow, easy-to-reason-about slice of turns qualifies for the fast
 * path that skips HarnessRuntime.run() — see triviality-classifier.test.ts
 * for the exact cases this is meant to catch and reject.
 */
export function classifyTriviality(message: string, riskLevel: RiskLevel): TrivialityClassification {
  if (riskLevel !== 'LOW') return { isTrivial: false, reason: 'not LOW risk' }

  const trimmed = message.trim()
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length
  if (wordCount > WORD_LIMIT) return { isTrivial: false, reason: 'too long for a one-shot fact lookup' }

  if (!FACTUAL_SHAPE.test(trimmed)) return { isTrivial: false, reason: 'not a self-contained factual question' }
  if (HISTORY_MARKERS.test(trimmed)) return { isTrivial: false, reason: 'references prior conversation' }
  if (GENERATIVE_MARKERS.test(trimmed)) return { isTrivial: false, reason: 'asks for reasoning or generated content' }
  if (COMPOUND_MARKERS.test(trimmed)) return { isTrivial: false, reason: 'compound request' }

  return { isTrivial: true, reason: 'self-contained factual question' }
}
