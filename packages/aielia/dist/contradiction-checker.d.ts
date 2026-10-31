import { ILLMClient, TokenUsage } from '@buildaharness/runtime';
import { ExternalContradictionInput } from '@buildaharness/harness';
export interface BeliefCandidate {
    id: string;
    statement: string;
}
/** Zero-LLM-call gate: true when a belief statement reads like a structured/technical (build, test, service, file) claim rather than a natural-language personal fact. */
export declare function looksLikeCodingFact(statement: string): boolean;
/**
 * `AUDIT_SEMANTIC_CONTRADICTION` gate — feature-value audit (Phase A4 of
 * the internal plan). Default **ON**: the semantic contradiction-checker
 * LLM call ships enabled, so an unset / empty / truthy value keeps today's behaviour. Set to a
 * falsy value (`0` / `false` / `off` / `no` / `disabled`) to skip the LLM call entirely and fall
 * back to the harness's always-on lexical / negation-pair check only. Read at exactly one call
 * site — `harness-bridge.ts`, where the `contradictionChecker` host hook is wired.
 */
export declare function semanticContradictionEnabled(env?: Record<string, string | undefined>): boolean;
/**
 * `AUDIT_SEMANTIC_CONTRADICTION_SEVERITY` (default OFF). The checker used to set no severity, so every semantic
 * contradiction recorded as MEDIUM and Tier 1 (DENY) was unreachable through it. On: the judgment also grades each
 * contradiction, and only "HIGH" (two claims that directly and explicitly cannot both hold) is passed on — anything
 * else, or a missing/unknown value, stays MEDIUM. Never LOW or SYSTEM_BREAKING.
 */
export declare function semanticContradictionSeverityEnabled(env?: Record<string, string | undefined>): boolean;
/** A newBelief restating/reinforcing an uncertainFacts or rejectedFacts entry in different words — see checkForContradictions' doc comment. Caller resolves which pool `existingId` came from by id membership (both ids are always from this call's own known-id set, filtered below). */
export interface Corroboration {
    existingId: string;
    newId: string;
}
export interface ContradictionCheckResult {
    contradictions: ExternalContradictionInput[];
    corroborations: Corroboration[];
}
export declare function checkForContradictions(newBeliefs: BeliefCandidate[], existingBeliefs: BeliefCandidate[], llmClient: ILLMClient, model?: string, onUsage?: (usage: TokenUsage) => void, uncertainFacts?: BeliefCandidate[], rejectedFacts?: BeliefCandidate[]): Promise<ContradictionCheckResult>;
