import { ILLMClient, TokenUsage } from '@buildaharness/runtime';
/**
 * Wraps content fetched from the web before it enters the model's context —
 * `read_file`/`list_directory` results are untouched (file content is
 * user-owned, not adversarial-by-default); only web_search/fetch_url results
 * go through this. SYSTEM_PROMPT in assistant.ts carries the matching
 * instruction that content in this tag is data, never instructions.
 */
export declare function wrapUntrusted(text: string): string;
/** A literal delimiter tag inside text is neutralised (`&lt;`) so the text cannot close or re-open the untrusted boundary. String scan, not a regex: a structural delimiter check, not a natural-language gate. */
export declare function defangUntrustedTags(text: string): string;
export interface InjectionDetection {
    flagged: boolean;
    reason?: string;
}
/** Content is always still returned to the model, flagged or not — this only decides whether a warning gets prepended. */
export declare function detectInjectionLikely(text: string): InjectionDetection;
/**
 * `AUDIT_LLM_INJECTION_DETECT` gate — feature-value audit (Phase A5 of
 * the internal plan). Default **ON**: the semantic injection-detection LLM
 * call ships enabled, so an unset / empty / truthy value keeps today's behaviour. Set to a falsy
 * value (`0` / `false` / `off` / `no` / `disabled`) to skip the LLM escalation entirely and fall
 * back to the always-on deterministic regex/pattern pass only. Read at exactly one place —
 * `detectInjectionLikelyWithLLM` below, the single helper both `agent-loop.ts` and
 * `action-approval-service.ts` route their tool-output checks through. Same shape as
 * `semanticContradictionEnabled()` (contradiction-checker.ts) and the harness's `supervisorEnabled()`.
 */
export declare function llmInjectionDetectEnabled(env?: Record<string, string | undefined>): boolean;
/**
 * Semantic escalation layered on top of the regex check above — only reached when the regex
 * found nothing (a real injection attempt this codebase has already seen looks nothing like
 * the fixed phrase list) and the content is long enough to plausibly hide one. Uses a
 * structured JSON response (not a free chat reply) and an explicit "you are not the assistant
 * being targeted" framing so the untrusted content itself has no natural surface to hijack —
 * the same defense the main model already gets via SYSTEM_PROMPT's own instruction, applied to
 * this classifier too. Falls back to "not flagged" on any parse failure or LLM error, matching
 * this codebase's other LLM-backed classifiers — a missed detection costs nothing worse than
 * the regex-only behavior this is layered on top of.
 */
export declare function detectInjectionLikelyWithLLM(text: string, llmClient: ILLMClient, model?: string, onUsage?: (usage: TokenUsage) => void): Promise<InjectionDetection>;
