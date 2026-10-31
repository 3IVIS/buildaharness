import { z } from 'zod';
export declare const StructureSchema: z.ZodObject<{
    id: z.ZodString;
    description: z.ZodString;
    token_count: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    id: string;
    description: string;
    token_count: number;
}, {
    id: string;
    description: string;
    token_count: number;
}>;
export type Structure = z.infer<typeof StructureSchema>;
export declare const PrunedRegionSchema: z.ZodObject<{
    id: z.ZodString;
    description: z.ZodString;
    token_count: z.ZodNumber;
    pruned_at: z.ZodString;
}, "strip", z.ZodTypeAny, {
    id: string;
    description: string;
    token_count: number;
    pruned_at: string;
}, {
    id: string;
    description: string;
    token_count: number;
    pruned_at: string;
}>;
export type PrunedRegion = z.infer<typeof PrunedRegionSchema>;
export declare const CompressionRiskSchema: z.ZodObject<{
    compressed_structures: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        description: z.ZodString;
        token_count: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        id: string;
        description: string;
        token_count: number;
    }, {
        id: string;
        description: string;
        token_count: number;
    }>, "many">;
    pruned_regions: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        description: z.ZodString;
        token_count: z.ZodNumber;
        pruned_at: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        description: string;
        token_count: number;
        pruned_at: string;
    }, {
        id: string;
        description: string;
        token_count: number;
        pruned_at: string;
    }>, "many">;
    dependent_tasks: z.ZodArray<z.ZodString, "many">;
}, "strip", z.ZodTypeAny, {
    compressed_structures: {
        id: string;
        description: string;
        token_count: number;
    }[];
    pruned_regions: {
        id: string;
        description: string;
        token_count: number;
        pruned_at: string;
    }[];
    dependent_tasks: string[];
}, {
    compressed_structures: {
        id: string;
        description: string;
        token_count: number;
    }[];
    pruned_regions: {
        id: string;
        description: string;
        token_count: number;
        pruned_at: string;
    }[];
    dependent_tasks: string[];
}>;
export type CompressionRisk = z.infer<typeof CompressionRiskSchema>;
export declare const TokenBudgetSchema: z.ZodObject<{
    total: z.ZodNumber;
    used: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    total: number;
    used: number;
}, {
    total: number;
    used: number;
}>;
export type TokenBudget = z.infer<typeof TokenBudgetSchema>;
export declare const JournalEntrySchema: z.ZodObject<{
    step: z.ZodNumber;
    action_class: z.ZodString;
    outcome: z.ZodString;
    verbatim: z.ZodOptional<z.ZodString>;
    success: z.ZodBoolean;
}, "strip", z.ZodTypeAny, {
    success: boolean;
    step: number;
    action_class: string;
    outcome: string;
    verbatim?: string | undefined;
}, {
    success: boolean;
    step: number;
    action_class: string;
    outcome: string;
    verbatim?: string | undefined;
}>;
export type JournalEntry = z.infer<typeof JournalEntrySchema>;
export declare const JournalRetentionPolicySchema: z.ZodObject<{
    retain_failures_permanently: z.ZodBoolean;
    max_passing_verbatim: z.ZodNumber;
    compress_older_passing: z.ZodBoolean;
}, "strip", z.ZodTypeAny, {
    retain_failures_permanently: boolean;
    max_passing_verbatim: number;
    compress_older_passing: boolean;
}, {
    retain_failures_permanently: boolean;
    max_passing_verbatim: number;
    compress_older_passing: boolean;
}>;
export type JournalRetentionPolicy = z.infer<typeof JournalRetentionPolicySchema>;
export declare const RollbackPointSchema: z.ZodObject<{
    id: z.ZodString;
    step: z.ZodNumber;
    description: z.ZodString;
    serialised_state: z.ZodString;
}, "strip", z.ZodTypeAny, {
    id: string;
    description: string;
    step: number;
    serialised_state: string;
}, {
    id: string;
    description: string;
    step: number;
    serialised_state: string;
}>;
export type RollbackPoint = z.infer<typeof RollbackPointSchema>;
export declare const MemoryStateSchema: z.ZodObject<{
    token_budget: z.ZodObject<{
        total: z.ZodNumber;
        used: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        total: number;
        used: number;
    }, {
        total: number;
        used: number;
    }>;
    compression_risk: z.ZodObject<{
        compressed_structures: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            description: z.ZodString;
            token_count: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            id: string;
            description: string;
            token_count: number;
        }, {
            id: string;
            description: string;
            token_count: number;
        }>, "many">;
        pruned_regions: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            description: z.ZodString;
            token_count: z.ZodNumber;
            pruned_at: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            id: string;
            description: string;
            token_count: number;
            pruned_at: string;
        }, {
            id: string;
            description: string;
            token_count: number;
            pruned_at: string;
        }>, "many">;
        dependent_tasks: z.ZodArray<z.ZodString, "many">;
    }, "strip", z.ZodTypeAny, {
        compressed_structures: {
            id: string;
            description: string;
            token_count: number;
        }[];
        pruned_regions: {
            id: string;
            description: string;
            token_count: number;
            pruned_at: string;
        }[];
        dependent_tasks: string[];
    }, {
        compressed_structures: {
            id: string;
            description: string;
            token_count: number;
        }[];
        pruned_regions: {
            id: string;
            description: string;
            token_count: number;
            pruned_at: string;
        }[];
        dependent_tasks: string[];
    }>;
    journal: z.ZodArray<z.ZodObject<{
        step: z.ZodNumber;
        action_class: z.ZodString;
        outcome: z.ZodString;
        verbatim: z.ZodOptional<z.ZodString>;
        success: z.ZodBoolean;
    }, "strip", z.ZodTypeAny, {
        success: boolean;
        step: number;
        action_class: string;
        outcome: string;
        verbatim?: string | undefined;
    }, {
        success: boolean;
        step: number;
        action_class: string;
        outcome: string;
        verbatim?: string | undefined;
    }>, "many">;
    journal_retention_policy: z.ZodObject<{
        retain_failures_permanently: z.ZodBoolean;
        max_passing_verbatim: z.ZodNumber;
        compress_older_passing: z.ZodBoolean;
    }, "strip", z.ZodTypeAny, {
        retain_failures_permanently: boolean;
        max_passing_verbatim: number;
        compress_older_passing: boolean;
    }, {
        retain_failures_permanently: boolean;
        max_passing_verbatim: number;
        compress_older_passing: boolean;
    }>;
    rollback_points: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        step: z.ZodNumber;
        description: z.ZodString;
        serialised_state: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        description: string;
        step: number;
        serialised_state: string;
    }, {
        id: string;
        description: string;
        step: number;
        serialised_state: string;
    }>, "many">;
    max_steps: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    token_budget: {
        total: number;
        used: number;
    };
    compression_risk: {
        compressed_structures: {
            id: string;
            description: string;
            token_count: number;
        }[];
        pruned_regions: {
            id: string;
            description: string;
            token_count: number;
            pruned_at: string;
        }[];
        dependent_tasks: string[];
    };
    journal: {
        success: boolean;
        step: number;
        action_class: string;
        outcome: string;
        verbatim?: string | undefined;
    }[];
    journal_retention_policy: {
        retain_failures_permanently: boolean;
        max_passing_verbatim: number;
        compress_older_passing: boolean;
    };
    rollback_points: {
        id: string;
        description: string;
        step: number;
        serialised_state: string;
    }[];
    max_steps: number;
}, {
    token_budget: {
        total: number;
        used: number;
    };
    compression_risk: {
        compressed_structures: {
            id: string;
            description: string;
            token_count: number;
        }[];
        pruned_regions: {
            id: string;
            description: string;
            token_count: number;
            pruned_at: string;
        }[];
        dependent_tasks: string[];
    };
    journal: {
        success: boolean;
        step: number;
        action_class: string;
        outcome: string;
        verbatim?: string | undefined;
    }[];
    journal_retention_policy: {
        retain_failures_permanently: boolean;
        max_passing_verbatim: number;
        compress_older_passing: boolean;
    };
    rollback_points: {
        id: string;
        description: string;
        step: number;
        serialised_state: string;
    }[];
    max_steps: number;
}>;
export type MemoryStateData = z.infer<typeof MemoryStateSchema>;
export declare class MemoryState {
    token_budget: TokenBudget;
    compression_risk: CompressionRisk;
    journal: JournalEntry[];
    journal_retention_policy: JournalRetentionPolicy;
    rollback_points: RollbackPoint[];
    max_steps: number;
    constructor(data?: Partial<MemoryStateData>);
    action_dep_overlap(actionWriteDomains: string[]): boolean;
    toJSON(): MemoryStateData;
    static fromJSON(json: MemoryStateData): MemoryState;
}
