import { z } from 'zod';
export declare const HypothesisSchema: z.ZodObject<{
    id: z.ZodString;
    explanation: z.ZodString;
    confidence: z.ZodNumber;
    predicted_observations: z.ZodArray<z.ZodString, "many">;
    discriminating_evidence: z.ZodArray<z.ZodString, "many">;
    generation_sources: z.ZodArray<z.ZodString, "many">;
    diversity_score: z.ZodNumber;
    /** Semantic hypotheses only: the check or observation that would tell this explanation apart from its rivals. */
    separating_check: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    id: string;
    confidence: number;
    explanation: string;
    predicted_observations: string[];
    discriminating_evidence: string[];
    generation_sources: string[];
    diversity_score: number;
    separating_check?: string | undefined;
}, {
    id: string;
    confidence: number;
    explanation: string;
    predicted_observations: string[];
    discriminating_evidence: string[];
    generation_sources: string[];
    diversity_score: number;
    separating_check?: string | undefined;
}>;
export type Hypothesis = z.infer<typeof HypothesisSchema>;
export declare const EliminationPolicySchema: z.ZodObject<{
    conditions: z.ZodArray<z.ZodString, "many">;
    retention_k: z.ZodNumber;
    floor: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    conditions: string[];
    retention_k: number;
    floor: number;
}, {
    conditions: string[];
    retention_k: number;
    floor: number;
}>;
export type EliminationPolicy = z.infer<typeof EliminationPolicySchema>;
export declare const HypothesisSetSchema: z.ZodObject<{
    active: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        explanation: z.ZodString;
        confidence: z.ZodNumber;
        predicted_observations: z.ZodArray<z.ZodString, "many">;
        discriminating_evidence: z.ZodArray<z.ZodString, "many">;
        generation_sources: z.ZodArray<z.ZodString, "many">;
        diversity_score: z.ZodNumber;
        /** Semantic hypotheses only: the check or observation that would tell this explanation apart from its rivals. */
        separating_check: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        confidence: number;
        explanation: string;
        predicted_observations: string[];
        discriminating_evidence: string[];
        generation_sources: string[];
        diversity_score: number;
        separating_check?: string | undefined;
    }, {
        id: string;
        confidence: number;
        explanation: string;
        predicted_observations: string[];
        discriminating_evidence: string[];
        generation_sources: string[];
        diversity_score: number;
        separating_check?: string | undefined;
    }>, "many">;
    eliminated: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        explanation: z.ZodString;
        confidence: z.ZodNumber;
        predicted_observations: z.ZodArray<z.ZodString, "many">;
        discriminating_evidence: z.ZodArray<z.ZodString, "many">;
        generation_sources: z.ZodArray<z.ZodString, "many">;
        diversity_score: z.ZodNumber;
        /** Semantic hypotheses only: the check or observation that would tell this explanation apart from its rivals. */
        separating_check: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        confidence: number;
        explanation: string;
        predicted_observations: string[];
        discriminating_evidence: string[];
        generation_sources: string[];
        diversity_score: number;
        separating_check?: string | undefined;
    }, {
        id: string;
        confidence: number;
        explanation: string;
        predicted_observations: string[];
        discriminating_evidence: string[];
        generation_sources: string[];
        diversity_score: number;
        separating_check?: string | undefined;
    }>, "many">;
    elimination_policy: z.ZodObject<{
        conditions: z.ZodArray<z.ZodString, "many">;
        retention_k: z.ZodNumber;
        floor: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        conditions: string[];
        retention_k: number;
        floor: number;
    }, {
        conditions: string[];
        retention_k: number;
        floor: number;
    }>;
}, "strip", z.ZodTypeAny, {
    active: {
        id: string;
        confidence: number;
        explanation: string;
        predicted_observations: string[];
        discriminating_evidence: string[];
        generation_sources: string[];
        diversity_score: number;
        separating_check?: string | undefined;
    }[];
    eliminated: {
        id: string;
        confidence: number;
        explanation: string;
        predicted_observations: string[];
        discriminating_evidence: string[];
        generation_sources: string[];
        diversity_score: number;
        separating_check?: string | undefined;
    }[];
    elimination_policy: {
        conditions: string[];
        retention_k: number;
        floor: number;
    };
}, {
    active: {
        id: string;
        confidence: number;
        explanation: string;
        predicted_observations: string[];
        discriminating_evidence: string[];
        generation_sources: string[];
        diversity_score: number;
        separating_check?: string | undefined;
    }[];
    eliminated: {
        id: string;
        confidence: number;
        explanation: string;
        predicted_observations: string[];
        discriminating_evidence: string[];
        generation_sources: string[];
        diversity_score: number;
        separating_check?: string | undefined;
    }[];
    elimination_policy: {
        conditions: string[];
        retention_k: number;
        floor: number;
    };
}>;
export type HypothesisSetData = z.infer<typeof HypothesisSetSchema>;
export declare class HypothesisSet {
    active: Hypothesis[];
    eliminated: Hypothesis[];
    elimination_policy: EliminationPolicy;
    constructor(data?: Partial<HypothesisSetData>);
    eliminate(hypothesis: Hypothesis): void;
    toJSON(): HypothesisSetData;
    static fromJSON(json: HypothesisSetData): HypothesisSet;
}
