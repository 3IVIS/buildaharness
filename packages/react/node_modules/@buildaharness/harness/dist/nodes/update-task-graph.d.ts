import { WorldModel } from '../state/world-model.js';
import { HypothesisSet } from '../state/hypothesis-set.js';
import { TaskGraph } from '../state/task-graph.js';
export declare class GraphCycleError extends Error {
    constructor(message: string);
}
export declare function updateTaskGraph(_objective: string, _worldModel: WorldModel, _hypothesisSet: HypothesisSet, taskGraph: TaskGraph): void;
