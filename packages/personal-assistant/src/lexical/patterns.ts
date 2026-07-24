/**
 * Loads personal-assistant's own lexical pattern data (packages/personal-assistant/src/lexical/
 * patterns/*.json) — the canonical, language-keyed source for this application's own checks
 * (fact extraction, risk classification, injection detection, enumeration, task-cancel matching,
 * ...). Distinct from packages/harness/src/lexical/patterns.ts (harness-core primitives, used by
 * packages/harness's own contradiction-detection nodes) — personal-assistant is one application
 * built on buildaharness, not a place for harness-core infrastructure to live, so these two
 * pattern sources stay separate even though they follow the same shape.
 *
 * Only "en" exists today; adding another language is a pure data addition to the JSON files, not
 * a code change here — every `get*Patterns()` below already returns one compiled pattern per
 * language present in the JSON, and `testAny` (see script-utils re-export) checks all of them.
 */
import factMarkersData from './patterns/fact-markers.json'
import riskPatternsData from './patterns/risk-patterns.json'
import injectionPatternsData from './patterns/injection-patterns.json'
import codingFactMarkersData from './patterns/coding-fact-markers.json'
import enumerationMarkersData from './patterns/enumeration-markers.json'
import taskCancelMarkersData from './patterns/task-cancel-markers.json'
import batchListMarkersData from './patterns/batch-list-markers.json'
import toolYieldMarkersData from './patterns/tool-yield-markers.json'
import templateKeywordsData from './patterns/template-keywords.json'

interface FactMarkersPerLang {
  factMarkers: string
  healthOrDietaryMarkers: string
  durableNameOrPreferenceMarkers: string
  nonClaimMarkers: string
  clauseBoundary: string
}

interface FactMarkersJson {
  [lang: string]: FactMarkersPerLang
}

export interface FactMarkerPatterns {
  factMarkers: RegExp[]
  healthOrDietaryMarkers: RegExp[]
  durableNameOrPreferenceMarkers: RegExp[]
  nonClaimMarkers: RegExp[]
  clauseBoundary: RegExp[]
}

function compileAcrossLanguages(data: FactMarkersJson): FactMarkerPatterns {
  const compiled: FactMarkerPatterns = { factMarkers: [], healthOrDietaryMarkers: [], durableNameOrPreferenceMarkers: [], nonClaimMarkers: [], clauseBoundary: [] }
  for (const lang of Object.values(data)) {
    compiled.factMarkers.push(new RegExp(lang.factMarkers, 'i'))
    compiled.healthOrDietaryMarkers.push(new RegExp(lang.healthOrDietaryMarkers, 'i'))
    compiled.durableNameOrPreferenceMarkers.push(new RegExp(lang.durableNameOrPreferenceMarkers, 'i'))
    compiled.nonClaimMarkers.push(new RegExp(lang.nonClaimMarkers, 'i'))
    compiled.clauseBoundary.push(new RegExp(lang.clauseBoundary, 'i'))
  }
  return compiled
}

const factMarkerPatterns = compileAcrossLanguages(factMarkersData as FactMarkersJson)

/** Matches fact-extraction.ts's FACT_MARKERS/HEALTH_OR_DIETARY_MARKERS/etc. — one compiled pattern per language. */
export function getFactMarkerPatterns(): FactMarkerPatterns {
  return factMarkerPatterns
}

/** True if `text` matches any of `patterns` — the "try every language, gate on either matching" rule (Decision 3). */
export function testAny(patterns: RegExp[], text: string): boolean {
  return patterns.some((p) => p.test(text))
}

/** Splits `text` on the first pattern (by language) that isn't empty-matching — clause boundaries don't need multi-language OR-ing the way a match test does, since splitting on any one language's boundary set is enough to separate clauses regardless of which language the boundary word came from. Currently just "en"; see splitClausesAcrossLanguages if a future language needs a genuinely different boundary shape combined in the same split. */
export function splitOnAny(patterns: RegExp[], text: string): string[] {
  let pieces = [text]
  for (const pattern of patterns) {
    pieces = pieces.flatMap((piece) => piece.split(pattern))
  }
  return pieces.map((s) => s.trim()).filter(Boolean)
}

// ─── risk-classifier.ts's patterns ──────────────────────────────────────────────────────────

export interface CompiledRiskPattern {
  pattern: RegExp
  reason: string
}

interface RiskPatternSource {
  source: string
  reason: string
}

interface RiskPatternsPerLang {
  highRiskPatterns: RiskPatternSource[]
  mediumRiskPatterns: RiskPatternSource[]
  reminderPattern: RiskPatternSource
  reminderRecallQuestion: string
  bulkReminderReason: string
  pastTenseQuestion: string
  firstPersonPastNarrative: string
  reportedThirdPartySpeech: string
  riskClauseBoundary: string
}

interface RiskPatternsJson {
  [lang: string]: RiskPatternsPerLang
}

export interface RiskPatterns {
  highRiskPatterns: CompiledRiskPattern[]
  mediumRiskPatterns: CompiledRiskPattern[]
  reminderPattern: CompiledRiskPattern
  reminderRecallQuestion: RegExp[]
  bulkReminderReason: string
  pastTenseQuestion: RegExp[]
  firstPersonPastNarrative: RegExp[]
  reportedThirdPartySpeech: RegExp[]
  riskClauseBoundary: RegExp[]
}

function compileRiskPattern(source: RiskPatternSource): CompiledRiskPattern {
  return { pattern: new RegExp(source.source, 'i'), reason: source.reason }
}

function compileRiskPatternsAcrossLanguages(data: RiskPatternsJson): RiskPatterns {
  const languages = Object.values(data)
  const first = languages[0]
  if (!first) throw new Error('risk-patterns.json has no languages defined')
  return {
    highRiskPatterns: languages.flatMap((lang) => lang.highRiskPatterns.map(compileRiskPattern)),
    mediumRiskPatterns: languages.flatMap((lang) => lang.mediumRiskPatterns.map(compileRiskPattern)),
    // Reason text stays whichever language declared it first (today: "en") — the assistant's own
    // output isn't translated by this change, only its ability to understand non-English input;
    // see plans/personal_assistant_chinese_lexical_checks_plan.html's Phase 4 for that separate,
    // later concern.
    reminderPattern: { pattern: new RegExp(languages.map((lang) => lang.reminderPattern.source).join('|'), 'i'), reason: first.reminderPattern.reason },
    reminderRecallQuestion: languages.map((lang) => new RegExp(lang.reminderRecallQuestion, 'i')),
    bulkReminderReason: first.bulkReminderReason,
    pastTenseQuestion: languages.map((lang) => new RegExp(lang.pastTenseQuestion, 'i')),
    firstPersonPastNarrative: languages.map((lang) => new RegExp(lang.firstPersonPastNarrative, 'i')),
    reportedThirdPartySpeech: languages.map((lang) => new RegExp(lang.reportedThirdPartySpeech, 'i')),
    riskClauseBoundary: languages.map((lang) => new RegExp(lang.riskClauseBoundary, 'i')),
  }
}

const riskPatterns = compileRiskPatternsAcrossLanguages(riskPatternsData as RiskPatternsJson)

/** Matches risk-classifier.ts's HIGH_RISK_PATTERNS/MEDIUM_RISK_PATTERNS/REMINDER_PATTERN/etc. */
export function getRiskPatterns(): RiskPatterns {
  return riskPatterns
}

// ─── trust-tagging.ts's patterns ────────────────────────────────────────────────────────────

interface InjectionPatternsPerLang {
  injectionPatterns: RiskPatternSource[]
}

interface InjectionPatternsJson {
  [lang: string]: InjectionPatternsPerLang
}

const injectionPatterns: CompiledRiskPattern[] = Object.values(injectionPatternsData as InjectionPatternsJson).flatMap((lang) =>
  lang.injectionPatterns.map(compileRiskPattern),
)

/** Matches trust-tagging.ts's INJECTION_PATTERNS. */
export function getInjectionPatterns(): CompiledRiskPattern[] {
  return injectionPatterns
}

// ─── contradiction-checker.ts's patterns ────────────────────────────────────────────────────

interface CodingFactMarkersPerLang {
  codingFactMarkers: string
}

interface CodingFactMarkersJson {
  [lang: string]: CodingFactMarkersPerLang
}

const codingFactMarkerPatterns: RegExp[] = Object.values(codingFactMarkersData as CodingFactMarkersJson).map(
  (lang) => new RegExp(lang.codingFactMarkers, 'i'),
)

/** Matches contradiction-checker.ts's CODING_FACT_MARKERS. */
export function getCodingFactMarkerPatterns(): RegExp[] {
  return codingFactMarkerPatterns
}

// ─── decomposition-classifier.ts's patterns ─────────────────────────────────────────────────

interface EnumerationMarkersPerLang {
  sequencingMarkers: string
  oneCommaListMarker: string
  twoCommaListMarker: string
  semicolonListMarker: string
  numberedListItem: string
  factThenSingleReminder: string
  remindWord: string
}

interface EnumerationMarkersJson {
  [lang: string]: EnumerationMarkersPerLang
}

export interface EnumerationPatterns {
  sequencingMarkers: RegExp[]
  oneCommaListMarker: RegExp[]
  twoCommaListMarker: RegExp[]
  semicolonListMarker: RegExp[]
  numberedListItem: RegExp[]
  factThenSingleReminder: RegExp[]
  remindWord: RegExp[]
}

function compileEnumerationAcrossLanguages(data: EnumerationMarkersJson): EnumerationPatterns {
  const languages = Object.values(data)
  return {
    sequencingMarkers: languages.map((lang) => new RegExp(lang.sequencingMarkers, 'i')),
    oneCommaListMarker: languages.map((lang) => new RegExp(lang.oneCommaListMarker, 'i')),
    twoCommaListMarker: languages.map((lang) => new RegExp(lang.twoCommaListMarker, 'i')),
    semicolonListMarker: languages.map((lang) => new RegExp(lang.semicolonListMarker, 'i')),
    numberedListItem: languages.map((lang) => new RegExp(lang.numberedListItem, 'g')),
    factThenSingleReminder: languages.map((lang) => new RegExp(lang.factThenSingleReminder, 'i')),
    remindWord: languages.map((lang) => new RegExp(lang.remindWord, 'gi')),
  }
}

const enumerationPatterns = compileEnumerationAcrossLanguages(enumerationMarkersData as EnumerationMarkersJson)

/** Matches decomposition-classifier.ts's SEQUENCING_MARKERS/ONE_COMMA_LIST_MARKER/etc. */
export function getEnumerationPatterns(): EnumerationPatterns {
  return enumerationPatterns
}

// ─── plan-store.ts's patterns ────────────────────────────────────────────────────────────────

interface TaskCancelMarkersPerLang {
  taskCancelVerbs: string
  taskReferenceMarker: string
  cancelMatchStopwords: string[]
}

interface TaskCancelMarkersJson {
  [lang: string]: TaskCancelMarkersPerLang
}

export interface TaskCancelPatterns {
  taskCancelVerbs: RegExp[]
  taskReferenceMarker: RegExp[]
  cancelMatchStopwords: ReadonlySet<string>
}

function compileTaskCancelAcrossLanguages(data: TaskCancelMarkersJson): TaskCancelPatterns {
  const languages = Object.values(data)
  const stopwords = new Set<string>()
  for (const lang of languages) for (const w of lang.cancelMatchStopwords) stopwords.add(w)
  return {
    taskCancelVerbs: languages.map((lang) => new RegExp(lang.taskCancelVerbs, 'i')),
    taskReferenceMarker: languages.map((lang) => new RegExp(lang.taskReferenceMarker, 'i')),
    cancelMatchStopwords: stopwords,
  }
}

const taskCancelPatterns = compileTaskCancelAcrossLanguages(taskCancelMarkersData as TaskCancelMarkersJson)

/** Matches plan-store.ts's TASK_CANCEL_VERBS/TASK_REFERENCE_MARKER/CANCEL_MATCH_STOPWORDS. */
export function getTaskCancelPatterns(): TaskCancelPatterns {
  return taskCancelPatterns
}

// ─── batch-list-detector.ts's patterns ──────────────────────────────────────────────────────

interface BatchListMarkersPerLang {
  connectorWords: string[]
}

interface BatchListMarkersJson {
  [lang: string]: BatchListMarkersPerLang
}

const connectorWords: ReadonlySet<string> = new Set(
  Object.values(batchListMarkersData as BatchListMarkersJson).flatMap((lang) => lang.connectorWords),
)

/** Matches batch-list-detector.ts's CONNECTOR_WORDS. */
export function getConnectorWords(): ReadonlySet<string> {
  return connectorWords
}

// ─── tool-yield-classifier.ts's patterns ────────────────────────────────────────────────────

interface ToolYieldMarkersPerLang {
  deadEndMarkers: string[]
}

interface ToolYieldMarkersJson {
  [lang: string]: ToolYieldMarkersPerLang
}

const deadEndMarkers: RegExp[] = Object.values(toolYieldMarkersData as ToolYieldMarkersJson).flatMap((lang) =>
  lang.deadEndMarkers.map((source) => new RegExp(source, 'i')),
)

/** Matches tool-yield-classifier.ts's DEAD_END_MARKERS. */
export function getDeadEndMarkers(): RegExp[] {
  return deadEndMarkers
}

// ─── plan-templates/index.ts's patterns ─────────────────────────────────────────────────────

interface TemplateKeywordsJson {
  [lang: string]: Record<string, string[]>
}

/**
 * Merges each template name's keyword list across every language present, preserving key
 * insertion order from the first language (today: "en") — pickTemplateForTask/
 * matchTemplateIfConfident's tie-breaking depends on that order (first-encountered max), and
 * with only one language today this is a no-op reshuffle.
 */
function mergeTemplateKeywordsAcrossLanguages(data: TemplateKeywordsJson): Record<string, string[]> {
  const merged: Record<string, string[]> = {}
  for (const lang of Object.values(data)) {
    for (const [name, keywords] of Object.entries(lang)) {
      merged[name] = [...(merged[name] ?? []), ...keywords]
    }
  }
  return merged
}

const templateKeywords = mergeTemplateKeywordsAcrossLanguages(templateKeywordsData as TemplateKeywordsJson)

/** Matches plan-templates/index.ts's TEMPLATE_KEYWORDS. */
export function getTemplateKeywords(): Record<string, string[]> {
  return templateKeywords
}
