import { ILLMClient, TokenUsage } from '@buildaharness/runtime';
import { AssistantSource } from './assistant-source.js';
/**
 * - 'grounded': every specific claim in the reply that rests on the tool results matches them.
 * - 'ungrounded': at least one specific claim or figure conflicts with, or isn't supported by,
 *   what the tools actually returned (`discrepancy` says which).
 * - 'not_checked': nothing was compared — no raw tool text was visible (claude-cli runs its tool
 *   loop in a subprocess), or the check errored / returned something unparseable.
 */
export type GroundingVerdict = 'grounded' | 'ungrounded' | 'not_checked';
export interface GroundingResult {
    verdict: GroundingVerdict;
    discrepancy?: string;
}
/**
 * `AUDIT_SEMANTIC_GROUNDING` gate. Default **ON**: an unset / empty / truthy value runs the grounding
 * check, so `answerClaim.verification_status` can only say `verified` for a reply that was compared
 * against the raw tool results. A falsy value (`0` / `false` / `off` / `no` / `disabled`) skips the
 * LLM call and restores the previous, mechanical-only derivation of `verified`. Same shape as
 * `semanticFailureMatchEnabled()`; read at exactly one site, assistant.ts's ResponseService wiring.
 */
export declare function semanticGroundingEnabled(env?: Record<string, string | undefined>): boolean;
/**
 * One bounded LLM call comparing a finished reply to the raw text its tools returned — the content
 * check `verify()` (mechanical/environmental tiers only) has no way to make. Returns `not_checked`
 * when there is nothing to compare or on any error, never a guessed `grounded`: a check that
 * couldn't run must not upgrade a reply to `verified`.
 */
export declare function checkReplyGrounding(input: {
    question: string;
    reply: string;
    sources: readonly AssistantSource[] | undefined;
}, llmClient: ILLMClient, model?: string, onUsage?: (usage: TokenUsage) => void): Promise<GroundingResult>;
