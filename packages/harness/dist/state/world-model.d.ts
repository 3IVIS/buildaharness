import { z } from 'zod';
export declare const ObservationSchema: z.ZodObject<{
    id: z.ZodString;
    content: z.ZodString;
    source: z.ZodString;
    recorded_at: z.ZodString;
}, "strip", z.ZodTypeAny, {
    source: string;
    id: string;
    content: string;
    recorded_at: string;
}, {
    source: string;
    id: string;
    content: string;
    recorded_at: string;
}>;
export type Observation = z.infer<typeof ObservationSchema>;
export declare const BeliefSchema: z.ZodObject<{
    id: z.ZodString;
    statement: z.ZodString;
    confidence: z.ZodNumber;
    derived_from: z.ZodArray<z.ZodString, "many">;
    supporting_evidence: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    reliability: z.ZodOptional<z.ZodString>;
    recorded_at: z.ZodString;
    applied_contradiction_ids: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    pending_sweep: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    id: string;
    recorded_at: string;
    statement: string;
    confidence: number;
    derived_from: string[];
    reliability?: string | undefined;
    supporting_evidence?: string[] | undefined;
    applied_contradiction_ids?: string[] | undefined;
    pending_sweep?: boolean | undefined;
}, {
    id: string;
    recorded_at: string;
    statement: string;
    confidence: number;
    derived_from: string[];
    reliability?: string | undefined;
    supporting_evidence?: string[] | undefined;
    applied_contradiction_ids?: string[] | undefined;
    pending_sweep?: boolean | undefined;
}>;
export type Belief = z.infer<typeof BeliefSchema>;
export declare const ContradictionSchema: z.ZodObject<{
    id: z.ZodString;
    type: z.ZodEnum<["pairwise", "set-level", "temporal", "abstraction"]>;
    severity: z.ZodEnum<["LOW", "MEDIUM", "HIGH", "SYSTEM_BREAKING"]>;
    scope: z.ZodEnum<["local", "task", "global"]>;
    description: z.ZodString;
    involved_belief_ids: z.ZodArray<z.ZodString, "many">;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "pairwise" | "set-level" | "temporal" | "abstraction";
    severity: "HIGH" | "MEDIUM" | "LOW" | "SYSTEM_BREAKING";
    scope: "local" | "task" | "global";
    description: string;
    involved_belief_ids: string[];
}, {
    id: string;
    type: "pairwise" | "set-level" | "temporal" | "abstraction";
    severity: "HIGH" | "MEDIUM" | "LOW" | "SYSTEM_BREAKING";
    scope: "local" | "task" | "global";
    description: string;
    involved_belief_ids: string[];
}>;
export type Contradiction = z.infer<typeof ContradictionSchema>;
export declare const EnvironmentChangeSchema: z.ZodObject<{
    id: z.ZodString;
    description: z.ZodString;
    affected_paths: z.ZodArray<z.ZodString, "many">;
    timestamp: z.ZodString;
}, "strip", z.ZodTypeAny, {
    id: string;
    description: string;
    affected_paths: string[];
    timestamp: string;
}, {
    id: string;
    description: string;
    affected_paths: string[];
    timestamp: string;
}>;
export type EnvironmentChange = z.infer<typeof EnvironmentChangeSchema>;
export declare const BeliefNodeSchema: z.ZodObject<{
    belief_id: z.ZodString;
    confidence: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    confidence: number;
    belief_id: string;
}, {
    confidence: number;
    belief_id: string;
}>;
export type BeliefNode = z.infer<typeof BeliefNodeSchema>;
export declare const DepEdgeSchema: z.ZodObject<{
    from: z.ZodString;
    to: z.ZodString;
    confidence: z.ZodNumber;
    verified: z.ZodBoolean;
}, "strip", z.ZodTypeAny, {
    confidence: number;
    from: string;
    to: string;
    verified: boolean;
}, {
    confidence: number;
    from: string;
    to: string;
    verified: boolean;
}>;
export type DepEdge = z.infer<typeof DepEdgeSchema>;
export declare const PropagationTaskSchema: z.ZodObject<{
    source_belief_id: z.ZodString;
    target_belief_id: z.ZodString;
}, "strip", z.ZodTypeAny, {
    source_belief_id: string;
    target_belief_id: string;
}, {
    source_belief_id: string;
    target_belief_id: string;
}>;
export type PropagationTask = z.infer<typeof PropagationTaskSchema>;
export declare const BeliefDepGraphSchema: z.ZodObject<{
    belief_nodes: z.ZodArray<z.ZodObject<{
        belief_id: z.ZodString;
        confidence: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        confidence: number;
        belief_id: string;
    }, {
        confidence: number;
        belief_id: string;
    }>, "many">;
    derived_from_edges: z.ZodArray<z.ZodObject<{
        from: z.ZodString;
        to: z.ZodString;
        confidence: z.ZodNumber;
        verified: z.ZodBoolean;
    }, "strip", z.ZodTypeAny, {
        confidence: number;
        from: string;
        to: string;
        verified: boolean;
    }, {
        confidence: number;
        from: string;
        to: string;
        verified: boolean;
    }>, "many">;
    invalidation_frontier: z.ZodArray<z.ZodString, "many">;
    propagation_queue: z.ZodArray<z.ZodObject<{
        source_belief_id: z.ZodString;
        target_belief_id: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        source_belief_id: string;
        target_belief_id: string;
    }, {
        source_belief_id: string;
        target_belief_id: string;
    }>, "many">;
    unverified_edge_ratio: z.ZodNumber;
    confidence_decay_rate: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    belief_nodes: {
        confidence: number;
        belief_id: string;
    }[];
    derived_from_edges: {
        confidence: number;
        from: string;
        to: string;
        verified: boolean;
    }[];
    invalidation_frontier: string[];
    propagation_queue: {
        source_belief_id: string;
        target_belief_id: string;
    }[];
    unverified_edge_ratio: number;
    confidence_decay_rate: number;
}, {
    belief_nodes: {
        confidence: number;
        belief_id: string;
    }[];
    derived_from_edges: {
        confidence: number;
        from: string;
        to: string;
        verified: boolean;
    }[];
    invalidation_frontier: string[];
    propagation_queue: {
        source_belief_id: string;
        target_belief_id: string;
    }[];
    unverified_edge_ratio: number;
    confidence_decay_rate: number;
}>;
export type BeliefDepGraphData = z.infer<typeof BeliefDepGraphSchema>;
export declare class BeliefDepGraph {
    belief_nodes: BeliefNode[];
    derived_from_edges: DepEdge[];
    invalidation_frontier: string[];
    propagation_queue: PropagationTask[];
    unverified_edge_ratio: number;
    confidence_decay_rate: number;
    constructor(data?: Partial<BeliefDepGraphData>);
    recomputeUnverifiedEdgeRatio(): void;
    toJSON(): BeliefDepGraphData;
    static fromJSON(json: BeliefDepGraphData): BeliefDepGraph;
}
export declare const DepGraphBudgetSchema: z.ZodObject<{
    max_unverified_edge_ratio: z.ZodNumber;
    refresh_policy: z.ZodString;
    confidence_decay_rate: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    confidence_decay_rate: number;
    max_unverified_edge_ratio: number;
    refresh_policy: string;
}, {
    confidence_decay_rate: number;
    max_unverified_edge_ratio: number;
    refresh_policy: string;
}>;
export type DepGraphBudgetData = z.infer<typeof DepGraphBudgetSchema>;
export declare class DepGraphBudget {
    max_unverified_edge_ratio: number;
    refresh_policy: string;
    confidence_decay_rate: number;
    constructor(data?: Partial<DepGraphBudgetData>);
    applyDecay(graph: BeliefDepGraph): void;
    toJSON(): DepGraphBudgetData;
    static fromJSON(json: DepGraphBudgetData): DepGraphBudget;
}
export declare const WorldModelSchema: z.ZodObject<{
    generation_id: z.ZodNumber;
    observations: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        content: z.ZodString;
        source: z.ZodString;
        recorded_at: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        source: string;
        id: string;
        content: string;
        recorded_at: string;
    }, {
        source: string;
        id: string;
        content: string;
        recorded_at: string;
    }>, "many">;
    beliefs: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        statement: z.ZodString;
        confidence: z.ZodNumber;
        derived_from: z.ZodArray<z.ZodString, "many">;
        supporting_evidence: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        reliability: z.ZodOptional<z.ZodString>;
        recorded_at: z.ZodString;
        applied_contradiction_ids: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        pending_sweep: z.ZodOptional<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        recorded_at: string;
        statement: string;
        confidence: number;
        derived_from: string[];
        reliability?: string | undefined;
        supporting_evidence?: string[] | undefined;
        applied_contradiction_ids?: string[] | undefined;
        pending_sweep?: boolean | undefined;
    }, {
        id: string;
        recorded_at: string;
        statement: string;
        confidence: number;
        derived_from: string[];
        reliability?: string | undefined;
        supporting_evidence?: string[] | undefined;
        applied_contradiction_ids?: string[] | undefined;
        pending_sweep?: boolean | undefined;
    }>, "many">;
    assumptions: z.ZodArray<z.ZodString, "many">;
    contradictions: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        type: z.ZodEnum<["pairwise", "set-level", "temporal", "abstraction"]>;
        severity: z.ZodEnum<["LOW", "MEDIUM", "HIGH", "SYSTEM_BREAKING"]>;
        scope: z.ZodEnum<["local", "task", "global"]>;
        description: z.ZodString;
        involved_belief_ids: z.ZodArray<z.ZodString, "many">;
    }, "strip", z.ZodTypeAny, {
        id: string;
        type: "pairwise" | "set-level" | "temporal" | "abstraction";
        severity: "HIGH" | "MEDIUM" | "LOW" | "SYSTEM_BREAKING";
        scope: "local" | "task" | "global";
        description: string;
        involved_belief_ids: string[];
    }, {
        id: string;
        type: "pairwise" | "set-level" | "temporal" | "abstraction";
        severity: "HIGH" | "MEDIUM" | "LOW" | "SYSTEM_BREAKING";
        scope: "local" | "task" | "global";
        description: string;
        involved_belief_ids: string[];
    }>, "many">;
    environment_change_log: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        description: z.ZodString;
        affected_paths: z.ZodArray<z.ZodString, "many">;
        timestamp: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        description: string;
        affected_paths: string[];
        timestamp: string;
    }, {
        id: string;
        description: string;
        affected_paths: string[];
        timestamp: string;
    }>, "many">;
    completeness_flags: z.ZodRecord<z.ZodString, z.ZodBoolean>;
    stale_flags: z.ZodRecord<z.ZodString, z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    generation_id: number;
    observations: {
        source: string;
        id: string;
        content: string;
        recorded_at: string;
    }[];
    beliefs: {
        id: string;
        recorded_at: string;
        statement: string;
        confidence: number;
        derived_from: string[];
        reliability?: string | undefined;
        supporting_evidence?: string[] | undefined;
        applied_contradiction_ids?: string[] | undefined;
        pending_sweep?: boolean | undefined;
    }[];
    assumptions: string[];
    contradictions: {
        id: string;
        type: "pairwise" | "set-level" | "temporal" | "abstraction";
        severity: "HIGH" | "MEDIUM" | "LOW" | "SYSTEM_BREAKING";
        scope: "local" | "task" | "global";
        description: string;
        involved_belief_ids: string[];
    }[];
    environment_change_log: {
        id: string;
        description: string;
        affected_paths: string[];
        timestamp: string;
    }[];
    completeness_flags: Record<string, boolean>;
    stale_flags: Record<string, boolean>;
}, {
    generation_id: number;
    observations: {
        source: string;
        id: string;
        content: string;
        recorded_at: string;
    }[];
    beliefs: {
        id: string;
        recorded_at: string;
        statement: string;
        confidence: number;
        derived_from: string[];
        reliability?: string | undefined;
        supporting_evidence?: string[] | undefined;
        applied_contradiction_ids?: string[] | undefined;
        pending_sweep?: boolean | undefined;
    }[];
    assumptions: string[];
    contradictions: {
        id: string;
        type: "pairwise" | "set-level" | "temporal" | "abstraction";
        severity: "HIGH" | "MEDIUM" | "LOW" | "SYSTEM_BREAKING";
        scope: "local" | "task" | "global";
        description: string;
        involved_belief_ids: string[];
    }[];
    environment_change_log: {
        id: string;
        description: string;
        affected_paths: string[];
        timestamp: string;
    }[];
    completeness_flags: Record<string, boolean>;
    stale_flags: Record<string, boolean>;
}>;
export type WorldModelData = z.infer<typeof WorldModelSchema>;
export declare class WorldModel {
    generation_id: number;
    observations: Observation[];
    beliefs: Belief[];
    assumptions: string[];
    contradictions: Contradiction[];
    environment_change_log: EnvironmentChange[];
    completeness_flags: Record<string, boolean>;
    stale_flags: Record<string, boolean>;
    constructor(data?: Partial<WorldModelData>);
    addBelief(belief: Belief): void;
    incrementGenerationId(): void;
    toJSON(): WorldModelData;
    static fromJSON(json: WorldModelData): WorldModel;
}
