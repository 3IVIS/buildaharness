import { ILLMClient, TokenUsage } from '@buildaharness/runtime';
export interface ConstraintViolation {
    constraint: string;
    reason?: string;
}
/**
 * `AUDIT_SEMANTIC_CONSTRAINT_CHECK` gate. Default **ON**: the harness's lexical caller-constraint check throws on any
 * reply that names the constraint's subject — including one that obeys it — so this replaces it rather than adding
 * to it, and only runs when the caller has set a constraint (the lexical check's own precondition). Set to a falsy
 * value (`0` / `false` / `off` / `no` / `disabled`) to keep the lexical check. Read at exactly one site: harness-bridge.ts.
 */
export declare function semanticConstraintCheckEnabled(env?: Record<string, string | undefined>): boolean;
/**
 * What to append to a reply the judge still found breaking a constraint after the one revision (the harness hands the answer
 * back with the violation instead of failing the turn). Empty when nothing is unresolved.
 */
export declare function renderUnresolvedConstraintNote(violations: ReadonlyArray<ConstraintViolation> | undefined): string;
/** Most standing constraints kept per session; the oldest drop first. */
export declare const MAX_STANDING_CONSTRAINTS = 8;
/**
 * Standing constraints plus the ones stated now: trimmed, de-duplicated (case-insensitive), the newest last, capped at
 * MAX_STANDING_CONSTRAINTS (oldest dropped). A constraint restated moves to the end rather than appearing twice.
 */
export declare function mergeStandingConstraints(existing: readonly string[], incoming: readonly string[]): string[];
/**
 * One bounded LLM call: does this reply break any of these constraints? Fails open — an error, an empty reply or an
 * unparseable answer is "no violations", so a broken check can never fail a turn that would have passed. Only
 * constraints the caller actually set are reported (a constraint the model invented is dropped).
 */
export declare function checkConstraints(input: {
    constraints: string[];
    reply: string;
}, llmClient: ILLMClient, model?: string, onUsage?: (usage: TokenUsage) => void): Promise<{
    violated: ConstraintViolation[];
}>;
