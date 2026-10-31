import { z } from 'zod';
/**
 * Phase 7 of the internal plan: a generic,
 * reusable resource budget, mirroring adapter/harness/recovery.py's RecoveryBudget shape
 * (four max_* caps + four *_used counters, isExhausted() as OR-of-thresholds, immutable —
 * consume() returns a new instance rather than mutating in place, so a caller can't
 * accidentally share/alias a budget across two unrelated objectives). Unlike RecoveryBudget,
 * which is scoped to the recovery layer specifically (tool calls/cost/time/plan revisions),
 * this type is deliberately domain-neutral (calls/cost/time/parallelism) so any caller —
 * batch-research today, other future harness consumers — can reuse it instead of hand-rolling
 * its own ad-hoc counter-plus-constant pair. Domain-specific calibration knobs (e.g.
 * batch-research's slack factor or large-projection threshold) have no analog here by design;
 * they stay as separate config passed alongside a Budget, not squeezed into it.
 */
export declare const BudgetSchema: z.ZodObject<{
    maxCalls: z.ZodNumber;
    maxCost: z.ZodNumber;
    maxTime: z.ZodNumber;
    maxParallelism: z.ZodNumber;
    callsUsed: z.ZodNumber;
    costUsed: z.ZodNumber;
    timeUsed: z.ZodNumber;
    parallelismUsed: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    maxCalls: number;
    maxCost: number;
    maxTime: number;
    maxParallelism: number;
    callsUsed: number;
    costUsed: number;
    timeUsed: number;
    parallelismUsed: number;
}, {
    maxCalls: number;
    maxCost: number;
    maxTime: number;
    maxParallelism: number;
    callsUsed: number;
    costUsed: number;
    timeUsed: number;
    parallelismUsed: number;
}>;
export type BudgetData = z.infer<typeof BudgetSchema>;
export interface BudgetConsumption {
    calls?: number;
    cost?: number;
    time?: number;
    parallelism?: number;
}
export declare class Budget {
    readonly maxCalls: number;
    readonly maxCost: number;
    readonly maxTime: number;
    readonly maxParallelism: number;
    readonly callsUsed: number;
    readonly costUsed: number;
    readonly timeUsed: number;
    readonly parallelismUsed: number;
    constructor(data?: Partial<BudgetData>);
    /** Any single exhausted dimension exhausts the whole budget — same OR-of-thresholds rule
     * as RecoveryBudget.is_exhausted(), for the same reason: a budget generous on cost but out
     * of calls shouldn't be treated as still usable. */
    isExhausted(): boolean;
    /** Remaining room on one dimension, floored at 0 (never negative). */
    remaining(dimension: 'calls' | 'cost' | 'time' | 'parallelism'): number;
    /** Returns a new Budget with the given deltas added to the used counters — immutable, like
     * RecoveryBudget.consume(). */
    consume(delta: BudgetConsumption): Budget;
    toJSON(): BudgetData;
    static fromJSON(json: Partial<BudgetData>): Budget;
}
