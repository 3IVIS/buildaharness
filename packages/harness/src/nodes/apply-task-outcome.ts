// Effect feedback (Phase H, ADR-003 F-2): the one State-write path for task-status
// transitions. TaskGraph.setStatus() still owns transition validation (terminal-COMPLETE
// guard, the FAILED/fromExecutionLayer restriction); applyTaskOutcome() is what execute.ts
// and harness-runtime.ts call instead of ctx.taskGraph.setStatus(...) directly — INV-17
// grep-gates that no other production call site does.
import { TaskGraph, type TaskStatus } from '../state/task-graph.js'

export interface TaskOutcome {
  status: TaskStatus
  fromExecutionLayer?: boolean
  // Not yet consumed — Phase D1's "not done → loop again" signal lands here.
  continue_?: boolean
}

export function applyTaskOutcome(taskGraph: TaskGraph, taskId: string, outcome: TaskOutcome): void {
  taskGraph.setStatus(taskId, outcome.status, { fromExecutionLayer: outcome.fromExecutionLayer })
}
