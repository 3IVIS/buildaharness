import { WorldModel, WorldModelData, BeliefDepGraph, BeliefDepGraphData } from './state/world-model.js';
import { CallerState, CallerStateData } from './state/caller-state.js';
import { ControlState, ControlStateData } from './state/control-state.js';
import { Diagnostics, DiagnosticsData } from './state/diagnostics.js';
import { TaskGraph, TaskGraphData } from './state/task-graph.js';
import { OutputContract, OutputContractData } from './state/output-contract.js';
import { EvidenceStore, EvidenceStoreData } from './state/evidence-store.js';
import { HypothesisSet, HypothesisSetData } from './state/hypothesis-set.js';
import { MemoryState, MemoryStateData } from './state/memory-state.js';
import { StrategyState, StrategyStateData } from './state/strategy-state.js';
import { FailureDiagnostics, FailureDiagnosticsData } from './state/failure-diagnostics.js';
import { ExperienceStore, ExperienceStoreData } from './state/experience-store.js';
export interface HarnessRunStateData {
    worldModel: WorldModelData;
    callerState: CallerStateData;
    controlState: ControlStateData;
    diagnostics: DiagnosticsData;
    taskGraph: TaskGraphData;
    outputContract: OutputContractData;
    evidenceStore: EvidenceStoreData;
    hypothesisSet: HypothesisSetData;
    memoryState: MemoryStateData;
    strategyState: StrategyStateData;
    failureDiagnostics: FailureDiagnosticsData;
    experienceStore: ExperienceStoreData;
    beliefDepGraph: BeliefDepGraphData;
}
export declare class HarnessRunState {
    worldModel: WorldModel;
    callerState: CallerState;
    controlState: ControlState;
    diagnostics: Diagnostics;
    taskGraph: TaskGraph;
    outputContract: OutputContract;
    evidenceStore: EvidenceStore;
    hypothesisSet: HypothesisSet;
    memoryState: MemoryState;
    strategyState: StrategyState;
    failureDiagnostics: FailureDiagnostics;
    experienceStore: ExperienceStore;
    beliefDepGraph: BeliefDepGraph;
    constructor(data?: Partial<{
        worldModel: WorldModel;
        callerState: CallerState;
        controlState: ControlState;
        diagnostics: Diagnostics;
        taskGraph: TaskGraph;
        outputContract: OutputContract;
        evidenceStore: EvidenceStore;
        hypothesisSet: HypothesisSet;
        memoryState: MemoryState;
        strategyState: StrategyState;
        failureDiagnostics: FailureDiagnostics;
        experienceStore: ExperienceStore;
        beliefDepGraph: BeliefDepGraph;
    }>);
    toJSON(): HarnessRunStateData;
    static fromJSON(json: HarnessRunStateData): HarnessRunState;
}
