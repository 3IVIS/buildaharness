import { z } from 'zod';
export declare const EvidenceTypeSchema: z.ZodEnum<["OBSERVATION", "INFERENCE", "SYSTEM_ERROR"]>;
export type EvidenceType = z.infer<typeof EvidenceTypeSchema>;
export declare const ReliabilitySchema: z.ZodEnum<["HIGH", "MEDIUM", "LOW"]>;
export type Reliability = z.infer<typeof ReliabilitySchema>;
export declare const EvidenceSchema: z.ZodObject<{
    id: z.ZodString;
    obs: z.ZodString;
    reliability: z.ZodEnum<["HIGH", "MEDIUM", "LOW"]>;
    source: z.ZodString;
    evidence_type: z.ZodEnum<["OBSERVATION", "INFERENCE", "SYSTEM_ERROR"]>;
    freshness: z.ZodString;
}, "strip", z.ZodTypeAny, {
    source: string;
    reliability: "HIGH" | "MEDIUM" | "LOW";
    id: string;
    freshness: string;
    obs: string;
    evidence_type: "OBSERVATION" | "INFERENCE" | "SYSTEM_ERROR";
}, {
    source: string;
    reliability: "HIGH" | "MEDIUM" | "LOW";
    id: string;
    freshness: string;
    obs: string;
    evidence_type: "OBSERVATION" | "INFERENCE" | "SYSTEM_ERROR";
}>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export declare const ToolReliabilityEnvelopeSchema: z.ZodObject<{
    tool: z.ZodString;
    max_observation_reliability: z.ZodEnum<["HIGH", "MEDIUM", "LOW"]>;
    max_conclusion_reliability: z.ZodEnum<["HIGH", "MEDIUM", "LOW"]>;
}, "strip", z.ZodTypeAny, {
    tool: string;
    max_observation_reliability: "HIGH" | "MEDIUM" | "LOW";
    max_conclusion_reliability: "HIGH" | "MEDIUM" | "LOW";
}, {
    tool: string;
    max_observation_reliability: "HIGH" | "MEDIUM" | "LOW";
    max_conclusion_reliability: "HIGH" | "MEDIUM" | "LOW";
}>;
export type ToolReliabilityEnvelope = z.infer<typeof ToolReliabilityEnvelopeSchema>;
export declare const ToolAvailabilitySchema: z.ZodObject<{
    available: z.ZodBoolean;
    fallback_tool: z.ZodNullable<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    available: boolean;
    fallback_tool: string | null;
}, {
    available: boolean;
    fallback_tool: string | null;
}>;
export type ToolAvailability = z.infer<typeof ToolAvailabilitySchema>;
export declare const EvidenceStoreSchema: z.ZodObject<{
    observations: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        obs: z.ZodString;
        reliability: z.ZodEnum<["HIGH", "MEDIUM", "LOW"]>;
        source: z.ZodString;
        evidence_type: z.ZodEnum<["OBSERVATION", "INFERENCE", "SYSTEM_ERROR"]>;
        freshness: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        source: string;
        reliability: "HIGH" | "MEDIUM" | "LOW";
        id: string;
        freshness: string;
        obs: string;
        evidence_type: "OBSERVATION" | "INFERENCE" | "SYSTEM_ERROR";
    }, {
        source: string;
        reliability: "HIGH" | "MEDIUM" | "LOW";
        id: string;
        freshness: string;
        obs: string;
        evidence_type: "OBSERVATION" | "INFERENCE" | "SYSTEM_ERROR";
    }>, "many">;
    tool_reliability_envelopes: z.ZodRecord<z.ZodString, z.ZodObject<{
        tool: z.ZodString;
        max_observation_reliability: z.ZodEnum<["HIGH", "MEDIUM", "LOW"]>;
        max_conclusion_reliability: z.ZodEnum<["HIGH", "MEDIUM", "LOW"]>;
    }, "strip", z.ZodTypeAny, {
        tool: string;
        max_observation_reliability: "HIGH" | "MEDIUM" | "LOW";
        max_conclusion_reliability: "HIGH" | "MEDIUM" | "LOW";
    }, {
        tool: string;
        max_observation_reliability: "HIGH" | "MEDIUM" | "LOW";
        max_conclusion_reliability: "HIGH" | "MEDIUM" | "LOW";
    }>>;
    tool_availability_manifest: z.ZodRecord<z.ZodString, z.ZodObject<{
        available: z.ZodBoolean;
        fallback_tool: z.ZodNullable<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        available: boolean;
        fallback_tool: string | null;
    }, {
        available: boolean;
        fallback_tool: string | null;
    }>>;
}, "strip", z.ZodTypeAny, {
    observations: {
        source: string;
        reliability: "HIGH" | "MEDIUM" | "LOW";
        id: string;
        freshness: string;
        obs: string;
        evidence_type: "OBSERVATION" | "INFERENCE" | "SYSTEM_ERROR";
    }[];
    tool_reliability_envelopes: Record<string, {
        tool: string;
        max_observation_reliability: "HIGH" | "MEDIUM" | "LOW";
        max_conclusion_reliability: "HIGH" | "MEDIUM" | "LOW";
    }>;
    tool_availability_manifest: Record<string, {
        available: boolean;
        fallback_tool: string | null;
    }>;
}, {
    observations: {
        source: string;
        reliability: "HIGH" | "MEDIUM" | "LOW";
        id: string;
        freshness: string;
        obs: string;
        evidence_type: "OBSERVATION" | "INFERENCE" | "SYSTEM_ERROR";
    }[];
    tool_reliability_envelopes: Record<string, {
        tool: string;
        max_observation_reliability: "HIGH" | "MEDIUM" | "LOW";
        max_conclusion_reliability: "HIGH" | "MEDIUM" | "LOW";
    }>;
    tool_availability_manifest: Record<string, {
        available: boolean;
        fallback_tool: string | null;
    }>;
}>;
export type EvidenceStoreData = z.infer<typeof EvidenceStoreSchema>;
export declare class EvidenceStore {
    observations: Evidence[];
    tool_reliability_envelopes: Record<string, ToolReliabilityEnvelope>;
    tool_availability_manifest: Record<string, ToolAvailability>;
    constructor(data?: Partial<EvidenceStoreData>);
    addObservation(evidence: Evidence): void;
    isToolAvailable(toolName: string): boolean;
    toJSON(): EvidenceStoreData;
    static fromJSON(json: EvidenceStoreData): EvidenceStore;
}
