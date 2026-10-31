import { WorldModel } from '../state/world-model.js';
import { TaskGraph } from '../state/task-graph.js';
export type RiskEstimate = 'LOW' | 'MEDIUM' | 'HIGH';
export type ModuleType = 'test' | 'business_logic' | 'infrastructure';
export interface RiskableAction {
    module_type: ModuleType;
    affected_files?: string[];
    lines_affected?: number;
    functions_affected?: number;
    metadata: Record<string, unknown>;
}
export declare function estimateRisk(action: RiskableAction, taskGraph: TaskGraph, _worldModel: WorldModel): RiskEstimate;
