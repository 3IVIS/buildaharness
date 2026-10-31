export interface FactMarkerPatterns {
    factMarkers: RegExp[];
    healthOrDietaryMarkers: RegExp[];
    durableNameOrPreferenceMarkers: RegExp[];
    nonClaimMarkers: RegExp[];
    clauseBoundary: RegExp[];
}
/** Matches fact-extraction.ts's FACT_MARKERS/HEALTH_OR_DIETARY_MARKERS/etc. — one compiled pattern per language. */
export declare function getFactMarkerPatterns(): FactMarkerPatterns;
/** True if `text` matches any of `patterns` — the "try every language, gate on either matching" rule (Decision 3). */
export declare function testAny(patterns: RegExp[], text: string): boolean;
/** Splits `text` on the first pattern (by language) that isn't empty-matching — clause boundaries don't need multi-language OR-ing the way a match test does, since splitting on any one language's boundary set is enough to separate clauses regardless of which language the boundary word came from. Currently just "en"; see splitClausesAcrossLanguages if a future language needs a genuinely different boundary shape combined in the same split. */
export declare function splitOnAny(patterns: RegExp[], text: string): string[];
export interface CompiledRiskPattern {
    pattern: RegExp;
    reason: string;
}
export interface RiskPatterns {
    highRiskPatterns: CompiledRiskPattern[];
    mediumRiskPatterns: CompiledRiskPattern[];
    reminderPattern: CompiledRiskPattern;
    reminderRecallQuestion: RegExp[];
    bulkReminderReason: string;
    pastTenseQuestion: RegExp[];
    firstPersonPastNarrative: RegExp[];
    reportedThirdPartySpeech: RegExp[];
    riskClauseBoundary: RegExp[];
}
/** Matches risk-classifier.ts's HIGH_RISK_PATTERNS/MEDIUM_RISK_PATTERNS/REMINDER_PATTERN/etc. */
export declare function getRiskPatterns(): RiskPatterns;
/** Matches trust-tagging.ts's INJECTION_PATTERNS. */
export declare function getInjectionPatterns(): CompiledRiskPattern[];
/** Matches contradiction-checker.ts's CODING_FACT_MARKERS. */
export declare function getCodingFactMarkerPatterns(): RegExp[];
export interface EnumerationPatterns {
    sequencingMarkers: RegExp[];
    oneCommaListMarker: RegExp[];
    twoCommaListMarker: RegExp[];
    semicolonListMarker: RegExp[];
    numberedListItem: RegExp[];
    factThenSingleReminder: RegExp[];
    remindWord: RegExp[];
}
/** Matches decomposition-classifier.ts's SEQUENCING_MARKERS/ONE_COMMA_LIST_MARKER/etc. */
export declare function getEnumerationPatterns(): EnumerationPatterns;
export interface TaskCancelPatterns {
    taskCancelVerbs: RegExp[];
    taskReferenceMarker: RegExp[];
    cancelMatchStopwords: ReadonlySet<string>;
}
/** Matches plan-store.ts's TASK_CANCEL_VERBS/TASK_REFERENCE_MARKER/CANCEL_MATCH_STOPWORDS. */
export declare function getTaskCancelPatterns(): TaskCancelPatterns;
export interface PlanModeCancelPatterns {
    cancelVerbs: RegExp[];
    planningReferenceMarker: RegExp[];
}
/** Matches plan-drafting-service.ts's exit-phrase detection ("cancel plan"/"abort planning"/...) — both a cancel-shaped verb AND an explicit reference to planning/drafting must match, same both-markers-required discipline getTaskCancelPatterns uses, so an unrelated "cancel my flight" said mid-draft doesn't spuriously exit plan mode. */
export declare function getPlanModeCancelPatterns(): PlanModeCancelPatterns;
/** Matches batch-list-detector.ts's CONNECTOR_WORDS. */
export declare function getConnectorWords(): ReadonlySet<string>;
/** Matches tool-yield-classifier.ts's DEAD_END_MARKERS. */
export declare function getDeadEndMarkers(): RegExp[];
/** Matches plan-templates/index.ts's TEMPLATE_KEYWORDS. */
export declare function getTemplateKeywords(): Record<string, string[]>;
