import { WorldModel, BeliefDepGraph, DepGraphBudget } from '../state/world-model.js';
import { CallerState } from '../state/caller-state.js';
import { ControlState } from '../state/control-state.js';
import { TaskGraph, Task } from '../state/task-graph.js';
import { Diagnostics } from '../state/diagnostics.js';
import { HypothesisSet } from '../state/hypothesis-set.js';
import { EvidenceStore } from '../state/evidence-store.js';
import { MemoryState } from '../state/memory-state.js';
import { StrategyState } from '../state/strategy-state.js';
import { FailureDiagnostics } from '../state/failure-diagnostics.js';
import { OutputContract } from '../state/output-contract.js';
import { ProcessRegistry } from '../process-registry.js';
export declare class SelfReferentialDependencyError extends Error {
    constructor(actionClass: string);
}
export declare class InvalidTaskGraphError extends Error {
    errors: string[];
    constructor(errors: string[]);
}
export declare function validateRecoveryActionDependencies(deps?: Record<string, string[]>): void;
export declare function validateTaskGraph(taskGraph: TaskGraph): string[];
export interface ToolConfig {
    available: boolean;
    fallback_tool?: string | null;
}
export interface HarnessInitOptions {
    max_steps?: number;
    toolConfigs?: Record<string, ToolConfig>;
    initialTasks?: Task[];
    successCriteria?: string[];
    callerConstraints?: string[];
    outputContract?: Partial<{
        format: string;
        required_sections: string[];
        required_interface_fields: string[];
        interface_constraints: Record<string, unknown>;
        validation_rules: string[];
        caller_specific_constraints: string[];
    }>;
    processConceptId?: string;
    processRegistry?: ProcessRegistry;
    recoveryActionDeps?: Record<string, string[]>;
}
export interface HarnessInitResult {
    worldModel: WorldModel;
    callerState: CallerState;
    controlState: ControlState;
    taskGraph: TaskGraph;
    diagnostics: Diagnostics;
    hypothesisSet: HypothesisSet;
    evidenceStore: EvidenceStore;
    memoryState: MemoryState;
    strategyState: StrategyState;
    failureDiagnostics: FailureDiagnostics;
    outputContract: OutputContract;
    beliefDepGraph: BeliefDepGraph;
    depGraphBudget: DepGraphBudget;
    maxSteps: number;
    decompositionGate: boolean;
    valid: boolean;
    errors: string[];
    processConceptId: string | null;
}
export declare function initializeHarness(_objective: string, options?: HarnessInitOptions): HarnessInitResult;
