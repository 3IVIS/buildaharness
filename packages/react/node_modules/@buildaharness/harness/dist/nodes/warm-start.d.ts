import { ExperienceStore } from '../state/experience-store.js';
import { FailureDiagnostics } from '../state/failure-diagnostics.js';
import { TaskGraph } from '../state/task-graph.js';
import { StrategyState, StrategyType } from '../state/strategy-state.js';
import { DepGraphBudget } from '../state/world-model.js';
export declare function softmaxStrategyPolicy(strategyState: StrategyState, temperature?: number): Record<StrategyType, number>;
export declare function warmStart(experienceStore: ExperienceStore, strategyState: StrategyState, failureDiagnostics: FailureDiagnostics, depGraphBudget: DepGraphBudget, _taskGraph: TaskGraph): void;
