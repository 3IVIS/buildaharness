import { ControlState } from '../state/control-state.js';
import { TaskGraph, Task } from '../state/task-graph.js';
export declare const PESSIMISTIC_THRESHOLD = 0.5;
export interface SelectTaskResult {
    task: Task | null;
    concurrentTask: Task | null;
    escalate: boolean;
}
export declare function selectTask(taskGraph: TaskGraph, controlState: ControlState): SelectTaskResult;
