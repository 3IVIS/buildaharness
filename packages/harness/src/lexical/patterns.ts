/**
 * Loads packages/harness's own lexical pattern data (packages/harness/src/lexical/patterns/*.json)
 * — the canonical, language-keyed source for negation-pair/trigger matching used by
 * detect-contradictions.ts and review-proposed-change.ts. Mirrored in
 * adapter/harness/lexical_patterns.py, which reads the same JSON files by path rather than a
 * hand-copied Python literal — see scripts/check-lexical-patterns-sync.mjs for the check that
 * guards against the two drifting apart.
 *
 * Only "en" exists today; adding another language is a pure data addition to the JSON files, not
 * a code change here.
 */
import negationData from './patterns/negation.json'

interface NegationPatternsJson {
  stopwords: string[]
  pairs: string[][]
  polarityWords: string[]
  reviewStopwords: string[]
  reviewTriggers: string[]
}

interface NegationPatterns {
  stopwords: string[]
  pairs: Array<[string, string]>
  polarityWords: string[]
  reviewStopwords: string[]
  reviewTriggers: string[]
}

interface NegationJson {
  [lang: string]: NegationPatternsJson
}

function mergeAcrossLanguages(data: NegationJson): NegationPatterns {
  const merged: NegationPatterns = { stopwords: [], pairs: [], polarityWords: [], reviewStopwords: [], reviewTriggers: [] }
  for (const lang of Object.values(data)) {
    merged.stopwords.push(...lang.stopwords)
    merged.pairs.push(...(lang.pairs as Array<[string, string]>))
    merged.polarityWords.push(...lang.polarityWords)
    merged.reviewStopwords.push(...lang.reviewStopwords)
    merged.reviewTriggers.push(...lang.reviewTriggers)
  }
  return merged
}

const negation = mergeAcrossLanguages(negationData as NegationJson)

/** `NEGATION_PAIRS` + `STOPWORDS` — matches detect-contradictions.ts's `statementsOpposed`. */
export function getNegationPairs(): { pairs: Array<[string, string]>; stopwords: ReadonlySet<string>; polarityWords: string[] } {
  return { pairs: negation.pairs, stopwords: new Set(negation.stopwords), polarityWords: negation.polarityWords }
}

/** `NEGATION_TRIGGERS` + `NEGATION_STOPWORDS` — matches review-proposed-change.ts's `isNegation`. */
export function getReviewNegationTriggers(): { triggers: string[]; stopwords: ReadonlySet<string> } {
  return { triggers: negation.reviewTriggers, stopwords: new Set(negation.reviewStopwords) }
}
