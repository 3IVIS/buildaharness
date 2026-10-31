import { WorldModel, BeliefDepGraph, DepGraphBudget } from '../state/world-model.js';
import { Evidence } from '../state/evidence-store.js';
import { Diagnostics } from '../state/diagnostics.js';
export interface BeliefInput {
    id?: string;
    statement?: string;
    derived_from: string[];
}
export declare function updateWorldModel(evidence: Evidence, worldModel: WorldModel, diagnostics: Diagnostics, beliefInput?: BeliefInput, regionKey?: string, prune?: boolean): void;
export declare function recomputeBeliefHealth(worldModel: WorldModel, diagnostics: Diagnostics): void;
export declare function propagateBeliefs(beliefDepGraph: BeliefDepGraph, depGraphBudget: DepGraphBudget, _worldModel: WorldModel): void;
