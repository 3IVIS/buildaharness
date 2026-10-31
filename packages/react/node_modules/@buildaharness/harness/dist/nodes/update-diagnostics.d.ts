import { WorldModel, BeliefDepGraph } from '../state/world-model.js';
import { HypothesisSet } from '../state/hypothesis-set.js';
import { TaskGraph } from '../state/task-graph.js';
import { FailureDiagnostics } from '../state/failure-diagnostics.js';
import { Diagnostics } from '../state/diagnostics.js';
/**
 * Matches adapter/harness/task_graph.py's check_abstraction_alignment(): compares each
 * task's abstraction_level against the world model's actual granularity, not a fixed
 * ceiling. force=true (used by the reviewer pass) bypasses the taskGraph.changed
 * short-circuit that otherwise skips recomputation.
 */
export declare function checkAbstractionAlignment(taskGraph: TaskGraph, worldModel: WorldModel, force?: boolean): number;
export declare function updateDiagnostics(worldModel: WorldModel, hypothesisSet: HypothesisSet, taskGraph: TaskGraph, failureDiagnostics: FailureDiagnostics, depGraph: BeliefDepGraph, diagnostics: Diagnostics, force?: boolean): void;
