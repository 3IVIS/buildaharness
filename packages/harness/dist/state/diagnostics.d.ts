import { z } from 'zod';
export declare const BeliefHealthSchema: z.ZodObject<{
    freshness: z.ZodNumber;
    consistency: z.ZodNumber;
    support: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    freshness: number;
    consistency: number;
    support: number;
}, {
    freshness: number;
    consistency: number;
    support: number;
}>;
export type BeliefHealth = z.infer<typeof BeliefHealthSchema>;
export declare const CoverageHealthSchema: z.ZodObject<{
    symptom_coverage: z.ZodNumber;
    explanation_coverage: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    symptom_coverage: number;
    explanation_coverage: number;
}, {
    symptom_coverage: number;
    explanation_coverage: number;
}>;
export type CoverageHealth = z.infer<typeof CoverageHealthSchema>;
export declare const VerificationHealthSchema: z.ZodObject<{
    strength: z.ZodNumber;
    feasibility: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    strength: number;
    feasibility: number;
}, {
    strength: number;
    feasibility: number;
}>;
export type VerificationHealth = z.infer<typeof VerificationHealthSchema>;
export declare const ExecutionHealthSchema: z.ZodObject<{
    progress_rate: z.ZodNumber;
    failure_recurrence: z.ZodNumber;
    oscillation_score: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    progress_rate: number;
    failure_recurrence: number;
    oscillation_score: number;
}, {
    progress_rate: number;
    failure_recurrence: number;
    oscillation_score: number;
}>;
export type ExecutionHealth = z.infer<typeof ExecutionHealthSchema>;
export declare const DimensionProvenanceSchema: z.ZodObject<{
    source: z.ZodDefault<z.ZodEnum<["deterministic", "model", "heuristic", "default"]>>;
    calibrated: z.ZodDefault<z.ZodBoolean>;
    evidence_ids: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
}, "strip", z.ZodTypeAny, {
    source: "deterministic" | "model" | "heuristic" | "default";
    calibrated: boolean;
    evidence_ids: string[];
}, {
    source?: "deterministic" | "model" | "heuristic" | "default" | undefined;
    calibrated?: boolean | undefined;
    evidence_ids?: string[] | undefined;
}>;
export type DimensionProvenance = z.infer<typeof DimensionProvenanceSchema>;
export declare const DiagnosticsSchema: z.ZodObject<{
    belief_health: z.ZodObject<{
        freshness: z.ZodNumber;
        consistency: z.ZodNumber;
        support: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        freshness: number;
        consistency: number;
        support: number;
    }, {
        freshness: number;
        consistency: number;
        support: number;
    }>;
    coverage_health: z.ZodObject<{
        symptom_coverage: z.ZodNumber;
        explanation_coverage: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        symptom_coverage: number;
        explanation_coverage: number;
    }, {
        symptom_coverage: number;
        explanation_coverage: number;
    }>;
    verification_health: z.ZodObject<{
        strength: z.ZodNumber;
        feasibility: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        strength: number;
        feasibility: number;
    }, {
        strength: number;
        feasibility: number;
    }>;
    execution_health: z.ZodObject<{
        progress_rate: z.ZodNumber;
        failure_recurrence: z.ZodNumber;
        oscillation_score: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        progress_rate: number;
        failure_recurrence: number;
        oscillation_score: number;
    }, {
        progress_rate: number;
        failure_recurrence: number;
        oscillation_score: number;
    }>;
    dep_class_gap_annotation: z.ZodString;
    provenance: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
        source: z.ZodDefault<z.ZodEnum<["deterministic", "model", "heuristic", "default"]>>;
        calibrated: z.ZodDefault<z.ZodBoolean>;
        evidence_ids: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        source: "deterministic" | "model" | "heuristic" | "default";
        calibrated: boolean;
        evidence_ids: string[];
    }, {
        source?: "deterministic" | "model" | "heuristic" | "default" | undefined;
        calibrated?: boolean | undefined;
        evidence_ids?: string[] | undefined;
    }>>>;
}, "strip", z.ZodTypeAny, {
    belief_health: {
        freshness: number;
        consistency: number;
        support: number;
    };
    coverage_health: {
        symptom_coverage: number;
        explanation_coverage: number;
    };
    verification_health: {
        strength: number;
        feasibility: number;
    };
    execution_health: {
        progress_rate: number;
        failure_recurrence: number;
        oscillation_score: number;
    };
    dep_class_gap_annotation: string;
    provenance: Record<string, {
        source: "deterministic" | "model" | "heuristic" | "default";
        calibrated: boolean;
        evidence_ids: string[];
    }>;
}, {
    belief_health: {
        freshness: number;
        consistency: number;
        support: number;
    };
    coverage_health: {
        symptom_coverage: number;
        explanation_coverage: number;
    };
    verification_health: {
        strength: number;
        feasibility: number;
    };
    execution_health: {
        progress_rate: number;
        failure_recurrence: number;
        oscillation_score: number;
    };
    dep_class_gap_annotation: string;
    provenance?: Record<string, {
        source?: "deterministic" | "model" | "heuristic" | "default" | undefined;
        calibrated?: boolean | undefined;
        evidence_ids?: string[] | undefined;
    }> | undefined;
}>;
export type DiagnosticsData = z.infer<typeof DiagnosticsSchema>;
export declare class Diagnostics {
    belief_health: BeliefHealth;
    coverage_health: CoverageHealth;
    verification_health: VerificationHealth;
    execution_health: ExecutionHealth;
    dep_class_gap_annotation: string;
    provenance: Record<string, DimensionProvenance>;
    constructor(data?: Partial<DiagnosticsData>);
    toJSON(): DiagnosticsData;
    static fromJSON(json: DiagnosticsData): Diagnostics;
}
