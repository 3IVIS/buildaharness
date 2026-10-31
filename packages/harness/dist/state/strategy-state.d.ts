import { z } from 'zod';
export declare const StrategyTypeSchema: z.ZodEnum<["DIRECT_EDIT", "TRACE_EXEC", "BROADER_SEARCH", "REIMPLEMENT", "MINIMAL_FIX", "ESCALATE"]>;
export type StrategyType = z.infer<typeof StrategyTypeSchema>;
export declare const DEFAULT_STRATEGY_ORDER: StrategyType[];
export declare const StrategyStateSchema: z.ZodObject<{
    current_strategy: z.ZodEnum<["DIRECT_EDIT", "TRACE_EXEC", "BROADER_SEARCH", "REIMPLEMENT", "MINIMAL_FIX", "ESCALATE"]>;
    switch_triggers: z.ZodArray<z.ZodString, "many">;
    prior_strategy_weights: z.ZodRecord<z.ZodString, z.ZodNumber>;
    recovery_strategy_order: z.ZodDefault<z.ZodArray<z.ZodEnum<["DIRECT_EDIT", "TRACE_EXEC", "BROADER_SEARCH", "REIMPLEMENT", "MINIMAL_FIX", "ESCALATE"]>, "many">>;
    switch_count: z.ZodNumber;
    stall_reason: z.ZodString;
    completion_history: z.ZodArray<z.ZodNumber, "many">;
    risk_state_history: z.ZodArray<z.ZodString, "many">;
    recovery_was_used: z.ZodBoolean;
    last_failure_class: z.ZodString;
}, "strip", z.ZodTypeAny, {
    current_strategy: "DIRECT_EDIT" | "TRACE_EXEC" | "BROADER_SEARCH" | "REIMPLEMENT" | "MINIMAL_FIX" | "ESCALATE";
    switch_triggers: string[];
    prior_strategy_weights: Record<string, number>;
    recovery_strategy_order: ("DIRECT_EDIT" | "TRACE_EXEC" | "BROADER_SEARCH" | "REIMPLEMENT" | "MINIMAL_FIX" | "ESCALATE")[];
    switch_count: number;
    stall_reason: string;
    completion_history: number[];
    risk_state_history: string[];
    recovery_was_used: boolean;
    last_failure_class: string;
}, {
    current_strategy: "DIRECT_EDIT" | "TRACE_EXEC" | "BROADER_SEARCH" | "REIMPLEMENT" | "MINIMAL_FIX" | "ESCALATE";
    switch_triggers: string[];
    prior_strategy_weights: Record<string, number>;
    switch_count: number;
    stall_reason: string;
    completion_history: number[];
    risk_state_history: string[];
    recovery_was_used: boolean;
    last_failure_class: string;
    recovery_strategy_order?: ("DIRECT_EDIT" | "TRACE_EXEC" | "BROADER_SEARCH" | "REIMPLEMENT" | "MINIMAL_FIX" | "ESCALATE")[] | undefined;
}>;
export type StrategyStateData = z.infer<typeof StrategyStateSchema>;
export declare class StrategyState {
    current_strategy: StrategyType;
    switch_triggers: string[];
    prior_strategy_weights: Record<string, number>;
    recovery_strategy_order: StrategyType[];
    switch_count: number;
    stall_reason: string;
    /** Running count of completed tasks recorded each iteration — used by cannot_make_progress() proxy 1. */
    completion_history: number[];
    /** Risk state string recorded each iteration — used by cannot_make_progress() proxy 4. */
    risk_state_history: string[];
    /** Whether a recovery strategy was used in the current run (P8). */
    recovery_was_used: boolean;
    /** The failure class that triggered the most recent strategy switch (P8). */
    last_failure_class: string;
    constructor(data?: Partial<StrategyStateData>);
    toJSON(): StrategyStateData;
    static fromJSON(json: StrategyStateData): StrategyState;
}
