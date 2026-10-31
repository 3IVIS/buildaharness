import { WorldModel, BeliefDepGraph, DepGraphBudget } from '../state/world-model.js';
import { HypothesisSet } from '../state/hypothesis-set.js';
import { TaskGraph } from '../state/task-graph.js';
import { Diagnostics } from '../state/diagnostics.js';
import { ControlState } from '../state/control-state.js';
import { CallerState } from '../state/caller-state.js';
import { MemoryState, Structure, PrunedRegion } from '../state/memory-state.js';
export interface CompressionResult {
    dropped: Structure[];
    pruned: PrunedRegion[];
}
export declare function contextCompression(memoryState: MemoryState, worldModel: WorldModel, beliefDepGraph: BeliefDepGraph, depGraphBudget: DepGraphBudget, hypothesisSet: HypothesisSet, taskGraph: TaskGraph, diagnostics: Diagnostics, controlState: ControlState, callerState: CallerState): void;
