import { StrategyType } from './strategy-state.js';
import { z } from 'zod';
export declare const MatchResultSchema: z.ZodObject<{
    failure_class: z.ZodString;
    confidence: z.ZodNumber;
    matched_pattern: z.ZodString;
    /** The matched curated entry's preferred recovery strategy, if it named one — see FailureModeEntrySchema.strategy_affinity and rollback-replan.ts's bias. Absent for an entry with none, or a semantic match whose id wasn't found in the library. */
    strategy_affinity: z.ZodOptional<z.ZodEnum<["DIRECT_EDIT", "TRACE_EXEC", "BROADER_SEARCH", "REIMPLEMENT", "MINIMAL_FIX", "ESCALATE"]>>;
}, "strip", z.ZodTypeAny, {
    confidence: number;
    failure_class: string;
    matched_pattern: string;
    strategy_affinity?: "DIRECT_EDIT" | "TRACE_EXEC" | "BROADER_SEARCH" | "REIMPLEMENT" | "MINIMAL_FIX" | "ESCALATE" | undefined;
}, {
    confidence: number;
    failure_class: string;
    matched_pattern: string;
    strategy_affinity?: "DIRECT_EDIT" | "TRACE_EXEC" | "BROADER_SEARCH" | "REIMPLEMENT" | "MINIMAL_FIX" | "ESCALATE" | undefined;
}>;
export type MatchResult = z.infer<typeof MatchResultSchema>;
export declare const FailureRecordSchema: z.ZodObject<{
    id: z.ZodString;
    timestamp: z.ZodString;
    failure_class: z.ZodString;
    description: z.ZodString;
    context: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}, "strip", z.ZodTypeAny, {
    id: string;
    description: string;
    timestamp: string;
    failure_class: string;
    context: Record<string, unknown>;
}, {
    id: string;
    description: string;
    timestamp: string;
    failure_class: string;
    context: Record<string, unknown>;
}>;
export type FailureRecord = z.infer<typeof FailureRecordSchema>;
export declare const FailureModeEntrySchema: z.ZodObject<{
    id: z.ZodString;
    failure_class: z.ZodString;
    symptoms: z.ZodArray<z.ZodString, "many">;
    pattern_description: z.ZodString;
    /**
     * The recovery strategy this failure class responds best to — e.g. a tool being unavailable
     * calls for REIMPLEMENT, not another DIRECT_EDIT attempt. Mirrors adapter/harness/failure_modes.py's
     * FailurePattern.strategy_affinity. Optional so an entry can be diagnostic-only (no lever), and so
     * old persisted entries (from before this field existed) still parse.
     */
    strategy_affinity: z.ZodOptional<z.ZodEnum<["DIRECT_EDIT", "TRACE_EXEC", "BROADER_SEARCH", "REIMPLEMENT", "MINIMAL_FIX", "ESCALATE"]>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    failure_class: string;
    symptoms: string[];
    pattern_description: string;
    strategy_affinity?: "DIRECT_EDIT" | "TRACE_EXEC" | "BROADER_SEARCH" | "REIMPLEMENT" | "MINIMAL_FIX" | "ESCALATE" | undefined;
}, {
    id: string;
    failure_class: string;
    symptoms: string[];
    pattern_description: string;
    strategy_affinity?: "DIRECT_EDIT" | "TRACE_EXEC" | "BROADER_SEARCH" | "REIMPLEMENT" | "MINIMAL_FIX" | "ESCALATE" | undefined;
}>;
export type FailureModeEntry = z.infer<typeof FailureModeEntrySchema>;
/**
 * Generic, model-agnostic seed patterns — same 4 failure classes as
 * adapter/harness/failure_modes.py's build_default_library(), re-expressed as short
 * free-text symptom phrases (this class's match() looks for substring containment against
 * observation text, not Python's required-condition keyword set). Curated once here; a fresh
 * run's FailureDiagnostics is seeded with these (see nodes/initialize.ts) so the library has
 * something to match against from the start — a run resumed from an older checkpoint keeps
 * whatever it was persisted with, seeded or not.
 */
export declare const DEFAULT_FAILURE_MODE_ENTRIES: FailureModeEntry[];
export declare class FailureModeLibrary {
    private entries;
    class_priors: Record<string, number>;
    constructor(entries?: FailureModeEntry[], class_priors?: Record<string, number>);
    /** Read-only view of the curated entries — used by a semantic (e.g. LLM-based) matcher layered on top of this class's own substring-overlap match() (see harness-runtime.ts's semanticFailureMatcher). */
    getEntries(): readonly FailureModeEntry[];
    match(symptoms: string[]): MatchResult | null;
    toJSON(): {
        entries: {
            id: string;
            failure_class: string;
            symptoms: string[];
            pattern_description: string;
            strategy_affinity?: "DIRECT_EDIT" | "TRACE_EXEC" | "BROADER_SEARCH" | "REIMPLEMENT" | "MINIMAL_FIX" | "ESCALATE" | undefined;
        }[];
        class_priors: Record<string, number>;
    };
}
/**
 * The semantic matcher only reports `{failure_class, confidence, matched_pattern: <entry id>}` —
 * it has no reason to know about `strategy_affinity`, since that's a property of the curated
 * entry, not something an LLM call about symptom text would invent. Looking the id back up in the
 * library is what lets a semantic match drive rollback-replan.ts's failure-mode bias exactly like
 * an exact match() already does. `undefined` when the id isn't found (a stale/hallucinated id).
 */
export declare function resolveSemanticMatchStrategy(semanticMatch: {
    matched_pattern: string;
}, entries: readonly FailureModeEntry[]): StrategyType | undefined;
export declare const FailureDiagnosticsSchema: z.ZodObject<{
    matched_pattern: z.ZodNullable<z.ZodObject<{
        failure_class: z.ZodString;
        confidence: z.ZodNumber;
        matched_pattern: z.ZodString;
        /** The matched curated entry's preferred recovery strategy, if it named one — see FailureModeEntrySchema.strategy_affinity and rollback-replan.ts's bias. Absent for an entry with none, or a semantic match whose id wasn't found in the library. */
        strategy_affinity: z.ZodOptional<z.ZodEnum<["DIRECT_EDIT", "TRACE_EXEC", "BROADER_SEARCH", "REIMPLEMENT", "MINIMAL_FIX", "ESCALATE"]>>;
    }, "strip", z.ZodTypeAny, {
        confidence: number;
        failure_class: string;
        matched_pattern: string;
        strategy_affinity?: "DIRECT_EDIT" | "TRACE_EXEC" | "BROADER_SEARCH" | "REIMPLEMENT" | "MINIMAL_FIX" | "ESCALATE" | undefined;
    }, {
        confidence: number;
        failure_class: string;
        matched_pattern: string;
        strategy_affinity?: "DIRECT_EDIT" | "TRACE_EXEC" | "BROADER_SEARCH" | "REIMPLEMENT" | "MINIMAL_FIX" | "ESCALATE" | undefined;
    }>>;
    failure_history: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        timestamp: z.ZodString;
        failure_class: z.ZodString;
        description: z.ZodString;
        context: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        description: string;
        timestamp: string;
        failure_class: string;
        context: Record<string, unknown>;
    }, {
        id: string;
        description: string;
        timestamp: string;
        failure_class: string;
        context: Record<string, unknown>;
    }>, "many">;
    failure_mode_library_data: z.ZodObject<{
        entries: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            failure_class: z.ZodString;
            symptoms: z.ZodArray<z.ZodString, "many">;
            pattern_description: z.ZodString;
            /**
             * The recovery strategy this failure class responds best to — e.g. a tool being unavailable
             * calls for REIMPLEMENT, not another DIRECT_EDIT attempt. Mirrors adapter/harness/failure_modes.py's
             * FailurePattern.strategy_affinity. Optional so an entry can be diagnostic-only (no lever), and so
             * old persisted entries (from before this field existed) still parse.
             */
            strategy_affinity: z.ZodOptional<z.ZodEnum<["DIRECT_EDIT", "TRACE_EXEC", "BROADER_SEARCH", "REIMPLEMENT", "MINIMAL_FIX", "ESCALATE"]>>;
        }, "strip", z.ZodTypeAny, {
            id: string;
            failure_class: string;
            symptoms: string[];
            pattern_description: string;
            strategy_affinity?: "DIRECT_EDIT" | "TRACE_EXEC" | "BROADER_SEARCH" | "REIMPLEMENT" | "MINIMAL_FIX" | "ESCALATE" | undefined;
        }, {
            id: string;
            failure_class: string;
            symptoms: string[];
            pattern_description: string;
            strategy_affinity?: "DIRECT_EDIT" | "TRACE_EXEC" | "BROADER_SEARCH" | "REIMPLEMENT" | "MINIMAL_FIX" | "ESCALATE" | undefined;
        }>, "many">;
        class_priors: z.ZodRecord<z.ZodString, z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        entries: {
            id: string;
            failure_class: string;
            symptoms: string[];
            pattern_description: string;
            strategy_affinity?: "DIRECT_EDIT" | "TRACE_EXEC" | "BROADER_SEARCH" | "REIMPLEMENT" | "MINIMAL_FIX" | "ESCALATE" | undefined;
        }[];
        class_priors: Record<string, number>;
    }, {
        entries: {
            id: string;
            failure_class: string;
            symptoms: string[];
            pattern_description: string;
            strategy_affinity?: "DIRECT_EDIT" | "TRACE_EXEC" | "BROADER_SEARCH" | "REIMPLEMENT" | "MINIMAL_FIX" | "ESCALATE" | undefined;
        }[];
        class_priors: Record<string, number>;
    }>;
}, "strip", z.ZodTypeAny, {
    matched_pattern: {
        confidence: number;
        failure_class: string;
        matched_pattern: string;
        strategy_affinity?: "DIRECT_EDIT" | "TRACE_EXEC" | "BROADER_SEARCH" | "REIMPLEMENT" | "MINIMAL_FIX" | "ESCALATE" | undefined;
    } | null;
    failure_history: {
        id: string;
        description: string;
        timestamp: string;
        failure_class: string;
        context: Record<string, unknown>;
    }[];
    failure_mode_library_data: {
        entries: {
            id: string;
            failure_class: string;
            symptoms: string[];
            pattern_description: string;
            strategy_affinity?: "DIRECT_EDIT" | "TRACE_EXEC" | "BROADER_SEARCH" | "REIMPLEMENT" | "MINIMAL_FIX" | "ESCALATE" | undefined;
        }[];
        class_priors: Record<string, number>;
    };
}, {
    matched_pattern: {
        confidence: number;
        failure_class: string;
        matched_pattern: string;
        strategy_affinity?: "DIRECT_EDIT" | "TRACE_EXEC" | "BROADER_SEARCH" | "REIMPLEMENT" | "MINIMAL_FIX" | "ESCALATE" | undefined;
    } | null;
    failure_history: {
        id: string;
        description: string;
        timestamp: string;
        failure_class: string;
        context: Record<string, unknown>;
    }[];
    failure_mode_library_data: {
        entries: {
            id: string;
            failure_class: string;
            symptoms: string[];
            pattern_description: string;
            strategy_affinity?: "DIRECT_EDIT" | "TRACE_EXEC" | "BROADER_SEARCH" | "REIMPLEMENT" | "MINIMAL_FIX" | "ESCALATE" | undefined;
        }[];
        class_priors: Record<string, number>;
    };
}>;
export type FailureDiagnosticsData = z.infer<typeof FailureDiagnosticsSchema>;
export declare class FailureDiagnostics {
    readonly failure_mode_library: FailureModeLibrary;
    matched_pattern: MatchResult | null;
    failure_history: FailureRecord[];
    constructor(data?: Partial<{
        failure_mode_library: FailureModeLibrary;
        matched_pattern: MatchResult | null;
        failure_history: FailureRecord[];
    }>);
    recordFailure(record: FailureRecord): void;
    toJSON(): FailureDiagnosticsData;
    static fromJSON(json: FailureDiagnosticsData): FailureDiagnostics;
}
