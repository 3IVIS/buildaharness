/**
 * G-2 — TurnContextBootstrap
 *
 * Configurable turn-state initialiser for multi-turn conversational agents.
 * Port of adapter/harness/turn_context.py. No domain vocabulary.
 */
export interface SessionField {
    key: string;
    default: unknown;
    sourcePath?: string;
    initOnce?: boolean;
}
export interface ResourceBudget {
    timeLimitSeconds: number;
    tokenBudget: number;
    budgetKey?: string;
    turnKey?: string;
}
export declare function makeTurnInitializer(fields: SessionField[], options?: {
    resourceBudget?: ResourceBudget;
    emptyModelKey?: string;
    emptyModelTemplate?: Record<string, unknown>;
}): (state: Record<string, unknown>) => Record<string, unknown>;
