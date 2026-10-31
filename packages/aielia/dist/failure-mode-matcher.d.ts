import { ILLMClient, TokenUsage } from '@buildaharness/runtime';
import { FailureModeEntry } from '@buildaharness/harness';
/**
 * `AUDIT_SEMANTIC_FAILURE_MATCH` gate — feature-value audit (Phase A6 of
 * the internal plan). Default **ON**: the semantic failure-mode-matcher
 * LLM call ships enabled, so an unset / empty / truthy value keeps today's behaviour. Set to a
 * falsy value (`0` / `false` / `off` / `no` / `disabled`) to skip the LLM call entirely and fall
 * back to `FailureModeLibrary.match()`'s exact-string-overlap check only. Read at exactly one call
 * site — `harness-bridge.ts`, where the `semanticFailureMatcher` host hook is wired. Same shape as
 * `semanticContradictionEnabled()` (contradiction-checker.ts) / `llmInjectionDetectEnabled()`
 * (trust-tagging.ts) and the harness's `supervisorEnabled()`.
 */
export declare function semanticFailureMatchEnabled(env?: Record<string, string | undefined>): boolean;
/**
 * One LLM call checking a symptom set against the whole failure-mode library at once (never
 * one call per entry) — layered on top of FailureModeLibrary.match()'s own exact-string-overlap
 * check, which requires a symptom to be byte-for-byte identical to a curated one. That exact-match
 * floor (and the shared-subject gates in detect-contradictions.ts / review-proposed-change.ts —
 * see looksLikeCodingFact's doc comment in contradiction-checker.ts) is why decomposition-classifier.ts
 * and plan-builder.ts prompt task descriptions to lead with their concrete subject: consistent
 * subject vocabulary gives every lexical layer, not just this one, real overlap to match on. Since
 * observations are free text ("Task executed: ...", "Result: ..."), exact equality against a
 * curated list almost never happens by chance — this is what actually lets the library
 * recognize a known failure pattern described in different words. Falls back to "no match" on
 * any parse failure or LLM error, matching this codebase's other LLM-backed classifiers — a
 * missed match costs nothing worse than the exact-match-only behavior this is layered on top of.
 */
export declare function checkSemanticFailureMatch(symptoms: string[], libraryEntries: readonly FailureModeEntry[], llmClient: ILLMClient, model?: string, onUsage?: (usage: TokenUsage) => void): Promise<{
    failure_class: string;
    confidence: number;
    matched_pattern: string;
} | null>;
