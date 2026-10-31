import { z } from 'zod';
export type TaskStatus = 'PENDING' | 'RUNNING' | 'COMPLETE' | 'FAILED' | 'BLOCKED' | 'HUMAN_REQUIRED';
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export declare const TaskSchema: z.ZodObject<{
    id: z.ZodString;
    description: z.ZodString;
    status: z.ZodEnum<["PENDING", "RUNNING", "COMPLETE", "FAILED", "BLOCKED", "HUMAN_REQUIRED"]>;
    risk_level: z.ZodEnum<["LOW", "MEDIUM", "HIGH"]>;
    depends_on: z.ZodArray<z.ZodString, "many">;
    parallel_write_domains: z.ZodArray<z.ZodString, "many">;
    abstraction_level: z.ZodNumber;
    assigned_strategy: z.ZodNullable<z.ZodString>;
    block_reason: z.ZodOptional<z.ZodString>;
    /**
     * Hierarchical goal tree fields (Phase 1 of plans/hierarchical_goal_tree_and_steering_plan.html)
     * — schema-only in this phase: nothing produces or consumes these yet (wiring lands Phase 4+),
     * so they're all optional and every existing Task literal/persisted record round-trips unchanged.
     * `node_kind` distinguishes an ordinary work item from a `goal_hypothesis` node — a competing
     * guess at the user's actual intent, per R3. `goal_id` is the stable task→goal parent link (R2)
     * so "which goal does this task belong to" is an O(1) field read, not a graph traversal.
     * `hypothesis_ids` groups a `goal_hypothesis` node with its sibling hypotheses, and
     * `relation_to_siblings` says whether those siblings are competing guesses where resolving one
     * abandons the others (`alternative`), or genuinely separate goals that coexist (`concurrent`).
     */
    node_kind: z.ZodOptional<z.ZodEnum<["task", "goal_hypothesis"]>>;
    goal_id: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    hypothesis_ids: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    relation_to_siblings: z.ZodOptional<z.ZodEnum<["alternative", "concurrent"]>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    status: "BLOCKED" | "HUMAN_REQUIRED" | "PENDING" | "RUNNING" | "COMPLETE" | "FAILED";
    description: string;
    risk_level: "HIGH" | "MEDIUM" | "LOW";
    depends_on: string[];
    parallel_write_domains: string[];
    abstraction_level: number;
    assigned_strategy: string | null;
    block_reason?: string | undefined;
    node_kind?: "task" | "goal_hypothesis" | undefined;
    goal_id?: string | null | undefined;
    hypothesis_ids?: string[] | undefined;
    relation_to_siblings?: "alternative" | "concurrent" | undefined;
}, {
    id: string;
    status: "BLOCKED" | "HUMAN_REQUIRED" | "PENDING" | "RUNNING" | "COMPLETE" | "FAILED";
    description: string;
    risk_level: "HIGH" | "MEDIUM" | "LOW";
    depends_on: string[];
    parallel_write_domains: string[];
    abstraction_level: number;
    assigned_strategy: string | null;
    block_reason?: string | undefined;
    node_kind?: "task" | "goal_hypothesis" | undefined;
    goal_id?: string | null | undefined;
    hypothesis_ids?: string[] | undefined;
    relation_to_siblings?: "alternative" | "concurrent" | undefined;
}>;
export type Task = z.infer<typeof TaskSchema>;
export type TaskNodeKind = NonNullable<Task['node_kind']>;
export type SiblingRelation = NonNullable<Task['relation_to_siblings']>;
export declare const TaskGraphSchema: z.ZodObject<{
    tasks: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        description: z.ZodString;
        status: z.ZodEnum<["PENDING", "RUNNING", "COMPLETE", "FAILED", "BLOCKED", "HUMAN_REQUIRED"]>;
        risk_level: z.ZodEnum<["LOW", "MEDIUM", "HIGH"]>;
        depends_on: z.ZodArray<z.ZodString, "many">;
        parallel_write_domains: z.ZodArray<z.ZodString, "many">;
        abstraction_level: z.ZodNumber;
        assigned_strategy: z.ZodNullable<z.ZodString>;
        block_reason: z.ZodOptional<z.ZodString>;
        /**
         * Hierarchical goal tree fields (Phase 1 of plans/hierarchical_goal_tree_and_steering_plan.html)
         * — schema-only in this phase: nothing produces or consumes these yet (wiring lands Phase 4+),
         * so they're all optional and every existing Task literal/persisted record round-trips unchanged.
         * `node_kind` distinguishes an ordinary work item from a `goal_hypothesis` node — a competing
         * guess at the user's actual intent, per R3. `goal_id` is the stable task→goal parent link (R2)
         * so "which goal does this task belong to" is an O(1) field read, not a graph traversal.
         * `hypothesis_ids` groups a `goal_hypothesis` node with its sibling hypotheses, and
         * `relation_to_siblings` says whether those siblings are competing guesses where resolving one
         * abandons the others (`alternative`), or genuinely separate goals that coexist (`concurrent`).
         */
        node_kind: z.ZodOptional<z.ZodEnum<["task", "goal_hypothesis"]>>;
        goal_id: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        hypothesis_ids: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        relation_to_siblings: z.ZodOptional<z.ZodEnum<["alternative", "concurrent"]>>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        status: "BLOCKED" | "HUMAN_REQUIRED" | "PENDING" | "RUNNING" | "COMPLETE" | "FAILED";
        description: string;
        risk_level: "HIGH" | "MEDIUM" | "LOW";
        depends_on: string[];
        parallel_write_domains: string[];
        abstraction_level: number;
        assigned_strategy: string | null;
        block_reason?: string | undefined;
        node_kind?: "task" | "goal_hypothesis" | undefined;
        goal_id?: string | null | undefined;
        hypothesis_ids?: string[] | undefined;
        relation_to_siblings?: "alternative" | "concurrent" | undefined;
    }, {
        id: string;
        status: "BLOCKED" | "HUMAN_REQUIRED" | "PENDING" | "RUNNING" | "COMPLETE" | "FAILED";
        description: string;
        risk_level: "HIGH" | "MEDIUM" | "LOW";
        depends_on: string[];
        parallel_write_domains: string[];
        abstraction_level: number;
        assigned_strategy: string | null;
        block_reason?: string | undefined;
        node_kind?: "task" | "goal_hypothesis" | undefined;
        goal_id?: string | null | undefined;
        hypothesis_ids?: string[] | undefined;
        relation_to_siblings?: "alternative" | "concurrent" | undefined;
    }>, "many">;
    conflict_probability_cache: z.ZodRecord<z.ZodString, z.ZodNumber>;
    changed: z.ZodBoolean;
}, "strip", z.ZodTypeAny, {
    tasks: {
        id: string;
        status: "BLOCKED" | "HUMAN_REQUIRED" | "PENDING" | "RUNNING" | "COMPLETE" | "FAILED";
        description: string;
        risk_level: "HIGH" | "MEDIUM" | "LOW";
        depends_on: string[];
        parallel_write_domains: string[];
        abstraction_level: number;
        assigned_strategy: string | null;
        block_reason?: string | undefined;
        node_kind?: "task" | "goal_hypothesis" | undefined;
        goal_id?: string | null | undefined;
        hypothesis_ids?: string[] | undefined;
        relation_to_siblings?: "alternative" | "concurrent" | undefined;
    }[];
    conflict_probability_cache: Record<string, number>;
    changed: boolean;
}, {
    tasks: {
        id: string;
        status: "BLOCKED" | "HUMAN_REQUIRED" | "PENDING" | "RUNNING" | "COMPLETE" | "FAILED";
        description: string;
        risk_level: "HIGH" | "MEDIUM" | "LOW";
        depends_on: string[];
        parallel_write_domains: string[];
        abstraction_level: number;
        assigned_strategy: string | null;
        block_reason?: string | undefined;
        node_kind?: "task" | "goal_hypothesis" | undefined;
        goal_id?: string | null | undefined;
        hypothesis_ids?: string[] | undefined;
        relation_to_siblings?: "alternative" | "concurrent" | undefined;
    }[];
    conflict_probability_cache: Record<string, number>;
    changed: boolean;
}>;
export type TaskGraphData = z.infer<typeof TaskGraphSchema>;
export declare function makeConflictKey(domainA: string, domainB: string): string;
export declare class TaskGraph {
    tasks: Task[];
    conflict_probability_cache: Record<string, number>;
    changed: boolean;
    constructor(data?: Partial<{
        tasks: Task[];
        conflict_probability_cache: Record<string, number>;
        changed: boolean;
    }>);
    getTask(id: string): Task | undefined;
    setStatus(taskId: string, newStatus: TaskStatus, options?: {
        fromExecutionLayer?: boolean;
    }): void;
    selectUnblockedLeaf(): Task | null;
    setConflictProbability(domainA: string, domainB: string, probability: number): void;
    getConflictProbability(domainA: string, domainB: string): number;
    toJSON(): TaskGraphData;
    static fromJSON(json: TaskGraphData): TaskGraph;
}
