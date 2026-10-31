import { StrategyState } from './state/strategy-state.js';
import { FailureDiagnostics } from './state/failure-diagnostics.js';
import { TaskGraph } from './state/task-graph.js';
import { WorldModel } from './state/world-model.js';
export interface StrategyTried {
    strategy: string;
    outcome: string;
}
export interface FailureClassCount {
    class: string;
    count: number;
}
export interface TrajectoryDigestData {
    goal: string[];
    steps_taken: number;
    stall_reason: string;
    stall_history: string[];
    strategies_tried: StrategyTried[];
    failure_classes: FailureClassCount[];
    reopened_tasks: string[];
    open_contradictions: string[];
    blocking_unknowns: string[];
    budget_remaining: Record<string, unknown>;
}
export declare class TrajectoryDigest {
    goal: string[];
    steps_taken: number;
    stall_reason: string;
    stall_history: string[];
    strategies_tried: StrategyTried[];
    failure_classes: FailureClassCount[];
    reopened_tasks: string[];
    open_contradictions: string[];
    blocking_unknowns: string[];
    budget_remaining: Record<string, unknown>;
    constructor(data?: Partial<TrajectoryDigestData>);
    toJSON(): TrajectoryDigestData;
    static fromJSON(json: unknown): TrajectoryDigest;
}
export interface BuildDigestOptions {
    successCriteria?: string[];
    recoveryBudget?: {
        toJSON(): Record<string, unknown>;
    } | Record<string, unknown> | null;
    reopenedTaskDescriptions?: string[];
    missingInfo?: string[];
}
/** Assemble a bounded TrajectoryDigest from live run state. Deterministic; no LLM. */
export declare function buildDigest(strategyState: StrategyState, failureDiagnostics: FailureDiagnostics | null | undefined, taskGraph: TaskGraph, worldModel: WorldModel, opts?: BuildDigestOptions): TrajectoryDigest;
