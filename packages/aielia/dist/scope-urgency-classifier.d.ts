import { ILLMClient, TokenUsage } from '@buildaharness/runtime';
export type ScopeRelation = 'SAME_TASK' | 'SAME_GOAL_NEW_TASK' | 'NEW_GOAL' | 'CANCEL_CURRENT';
export type Urgency = 'IMMEDIATE' | 'DEFERRED';
export interface ScopeUrgencyClassification {
    scopeRelation: ScopeRelation;
    urgency: Urgency;
}
/** What the classifier is given to judge scope against — the best available proxy for "the task/goal in flight" this phase has: the active GoalThread's own successCriteria/rationale, not a live per-task pointer (that's Phase 5's Scheduler territory). */
export interface ScopeUrgencyContext {
    currentGoalDescription: string | null;
}
/**
 * INV-41 — on classifier uncertainty (a malformed response, an LLM error, or an unrecognized enum
 * value), default to SAME_GOAL_NEW_TASK × DEFERRED rather than a neutral coin flip. Same fail-safe
 * philosophy as turn-intent-classifier.ts's UNKNOWN → requiresApproval, but a different asymmetry
 * (see the plan's "Fail-safe default" section): a wrongly-deferred request costs the user one
 * clarifying nudge later, a wrongly-preempted task costs the work already in flight — bias toward
 * "queue it, don't switch."
 */
export declare const FAIL_SAFE_CLASSIFICATION: ScopeUrgencyClassification;
/**
 * One bounded LLM call per steering message — same callChatStructured shape as
 * matchGoalIdentity/checkForContradictions. SAME_TASK always collapses to IMMEDIATE regardless of
 * what the model reports for urgency (see the plan: "a deferred correction to the task you're
 * already on isn't really a correction"). Any parse failure, thrown error, or unrecognized enum
 * value collapses to FAIL_SAFE_CLASSIFICATION (INV-41) — never thrown, never a silent default to a
 * more disruptive branch.
 */
export declare function classifyScopeUrgency(message: string, context: ScopeUrgencyContext, llmClient: ILLMClient, model?: string, onUsage?: (usage: TokenUsage) => void): Promise<ScopeUrgencyClassification>;
