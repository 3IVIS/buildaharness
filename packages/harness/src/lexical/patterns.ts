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
import granularityData from './patterns/granularity-markers.json'

interface NegationPatternsJson {
  stopwords: string[]
  pairs: string[][]
  polarityWords: string[]
  reviewStopwords: string[]
  reviewTriggers: string[]
  evidenceNegationWords: string[]
  constraintNegationWords: string[]
}

interface NegationPatterns {
  stopwords: string[]
  pairs: Array<[string, string]>
  polarityWords: string[]
  reviewStopwords: string[]
  reviewTriggers: string[]
  evidenceNegationWords: string[]
  constraintNegationWords: string[]
}

interface NegationJson {
  [lang: string]: NegationPatternsJson
}

function mergeAcrossLanguages(data: NegationJson): NegationPatterns {
  const merged: NegationPatterns = {
    stopwords: [],
    pairs: [],
    polarityWords: [],
    reviewStopwords: [],
    reviewTriggers: [],
    evidenceNegationWords: [],
    constraintNegationWords: [],
  }
  for (const lang of Object.values(data)) {
    merged.stopwords.push(...lang.stopwords)
    merged.pairs.push(...(lang.pairs as Array<[string, string]>))
    merged.polarityWords.push(...lang.polarityWords)
    merged.reviewStopwords.push(...lang.reviewStopwords)
    merged.reviewTriggers.push(...lang.reviewTriggers)
    merged.evidenceNegationWords.push(...lang.evidenceNegationWords)
    merged.constraintNegationWords.push(...lang.constraintNegationWords)
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

/**
 * Negation markers used to detect whether a caller_specific_constraint is negatively phrased
 * ("must not reference X", "without Y") — matches output-validation.ts's `outputValidation`,
 * mirrored in adapter/harness/output_contract.py's `check_caller_specific_constraints`. Both
 * previously hardcoded their own identical copy of this set; this is the single source both now
 * read.
 */
export function getConstraintNegationWords(): ReadonlySet<string> {
  return new Set(negation.constraintNegationWords)
}

interface GranularityMarkersPerLang {
  statementLevelMarkers: string[]
  functionLevelMarkers: string[]
}

interface GranularityMarkersJson {
  [lang: string]: GranularityMarkersPerLang
}

interface GranularityMarkers {
  statementLevelMarkers: string[]
  functionLevelMarkers: string[]
}

function mergeGranularityAcrossLanguages(data: GranularityMarkersJson): GranularityMarkers {
  const merged: GranularityMarkers = { statementLevelMarkers: [], functionLevelMarkers: [] }
  for (const lang of Object.values(data)) {
    merged.statementLevelMarkers.push(...lang.statementLevelMarkers)
    merged.functionLevelMarkers.push(...lang.functionLevelMarkers)
  }
  return merged
}

const granularity = mergeGranularityAcrossLanguages(granularityData as GranularityMarkersJson)

/**
 * Code-granularity keyword markers — merges what used to be two separate, overlapping-but-not-
 * identical lists: detect-contradictions.ts's `LINE_LEVEL_KEYWORDS` (used by
 * `detectAbstractionContradictions`'s LOW-severity advisory check) and update-diagnostics.ts's
 * `statementMarkers`/`functionMarkers` (used by `estimateWorldModelGranularity`'s 0/1/2
 * module/function/statement classification). Mirrored in adapter/harness/lexical_patterns.py,
 * read by contradiction.py and task_graph.py.
 */
export function getGranularityMarkers(): { statementLevelMarkers: string[]; functionLevelMarkers: string[] } {
  return { statementLevelMarkers: granularity.statementLevelMarkers, functionLevelMarkers: granularity.functionLevelMarkers }
}
