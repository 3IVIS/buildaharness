/** `NEGATION_PAIRS` + `STOPWORDS` — matches detect-contradictions.ts's `statementsOpposed`. */
export declare function getNegationPairs(): {
    pairs: Array<[string, string]>;
    stopwords: ReadonlySet<string>;
    polarityWords: string[];
};
/** `NEGATION_TRIGGERS` + `NEGATION_STOPWORDS` — matches review-proposed-change.ts's `isNegation`. */
export declare function getReviewNegationTriggers(): {
    triggers: string[];
    stopwords: ReadonlySet<string>;
};
/**
 * Negation markers used to detect whether a caller_specific_constraint is negatively phrased
 * ("must not reference X", "without Y") — matches output-validation.ts's `outputValidation`,
 * mirrored in adapter/harness/output_contract.py's `check_caller_specific_constraints`. Both
 * previously hardcoded their own identical copy of this set; this is the single source both now
 * read.
 */
export declare function getConstraintNegationWords(): ReadonlySet<string>;
/**
 * Code-granularity keyword markers — merges what used to be two separate, overlapping-but-not-
 * identical lists: detect-contradictions.ts's `LINE_LEVEL_KEYWORDS` (used by
 * `detectAbstractionContradictions`'s LOW-severity advisory check) and update-diagnostics.ts's
 * `statementMarkers`/`functionMarkers` (used by `estimateWorldModelGranularity`'s 0/1/2
 * module/function/statement classification). Mirrored in adapter/harness/lexical_patterns.py,
 * read by contradiction.py and task_graph.py.
 */
export declare function getGranularityMarkers(): {
    statementLevelMarkers: string[];
    functionLevelMarkers: string[];
};
