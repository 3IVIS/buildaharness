import { TaskGraph, TaskStatus } from '../state/task-graph.js';
export interface TaskOutcome {
    status: TaskStatus;
    fromExecutionLayer?: boolean;
    continue_?: boolean;
}
export declare function applyTaskOutcome(taskGraph: TaskGraph, taskId: string, outcome: TaskOutcome): void;
