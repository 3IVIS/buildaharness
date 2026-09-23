import { z } from 'zod'

export type TaskStatus = 'PENDING' | 'RUNNING' | 'COMPLETE' | 'FAILED' | 'BLOCKED' | 'HUMAN_REQUIRED'
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH'

export const TaskSchema = z.object({
  id: z.string(),
  description: z.string(),
  status: z.enum(['PENDING', 'RUNNING', 'COMPLETE', 'FAILED', 'BLOCKED', 'HUMAN_REQUIRED']),
  risk_level: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  depends_on: z.array(z.string()),
  parallel_write_domains: z.array(z.string()),
  abstraction_level: z.number().int().nonnegative(),
  assigned_strategy: z.string().nullable(),
  block_reason: z.string().optional(),
  /**
   * Hierarchical goal tree fields (Phase 1 of plans/hierarchical_goal_tree_and_steering_plan.html)
   * — schema-only in this phase: nothing produces or consumes these yet (wiring lands Phase 4+),
   * so they're all optional and every existing Task literal/persisted record round-trips unchanged.
   * `node_kind` distinguishes an ordinary work item from a `goal_hypothesis` node — a competing
   * guess at the user's actual intent, per R3. `goal_id` is the stable task→goal parent link (R2)
   * so "which goal does this task belong to" is an O(1) field read, not a graph traversal.
   * `hypothesis_ids` groups a `goal_hypothesis` node with its sibling hypotheses, and
   * `relation_to_siblings` says whether those siblings are competing guesses where resolving one
   * abandons the others (`alternative`), or genuinely separate goals that coexist (`concurrent`).
   */
  node_kind: z.enum(['task', 'goal_hypothesis']).optional(),
  goal_id: z.string().nullable().optional(),
  hypothesis_ids: z.array(z.string()).optional(),
  relation_to_siblings: z.enum(['alternative', 'concurrent']).optional(),
})
export type Task = z.infer<typeof TaskSchema>
export type TaskNodeKind = NonNullable<Task['node_kind']>
export type SiblingRelation = NonNullable<Task['relation_to_siblings']>

export const TaskGraphSchema = z.object({
  tasks: z.array(TaskSchema),
  conflict_probability_cache: z.record(z.number()),
  changed: z.boolean(),
})
export type TaskGraphData = z.infer<typeof TaskGraphSchema>

export function makeConflictKey(domainA: string, domainB: string): string {
  return [domainA, domainB].sort().join('::')
}

export class TaskGraph {
  tasks: Task[]
  conflict_probability_cache: Record<string, number>
  changed: boolean

  constructor(data?: Partial<{ tasks: Task[]; conflict_probability_cache: Record<string, number>; changed: boolean }>) {
    this.tasks = data?.tasks ?? []
    this.conflict_probability_cache = data?.conflict_probability_cache ?? {}
    this.changed = data?.changed ?? false
  }

  getTask(id: string): Task | undefined {
    return this.tasks.find(t => t.id === id)
  }

  setStatus(taskId: string, newStatus: TaskStatus, options: { fromExecutionLayer?: boolean } = {}): void {
    const task = this.getTask(taskId)
    if (!task) throw new Error(`TaskGraph: task "${taskId}" not found`)
    if (task.status === 'COMPLETE') {
      throw new Error(`TaskGraph: task "${taskId}" is in terminal status COMPLETE; no further transitions allowed`)
    }
    if (newStatus === 'FAILED' && !options.fromExecutionLayer) {
      throw new Error(`TaskGraph: status FAILED can only be set by the execution layer`)
    }
    task.status = newStatus
    this.changed = true
  }

  selectUnblockedLeaf(): Task | null {
    const taskMap = new Map(this.tasks.map(t => [t.id, t]))
    const eligible = this.tasks.filter(t => {
      if (t.status !== 'PENDING') return false
      return t.depends_on.every(depId => taskMap.get(depId)?.status === 'COMPLETE')
    })
    if (eligible.length === 0) return null
    const riskOrder: Record<RiskLevel, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 }
    // stable sort: Array.sort is stable in V8 (ES2019+)
    eligible.sort((a, b) => riskOrder[a.risk_level] - riskOrder[b.risk_level])
    return eligible[0]
  }

  setConflictProbability(domainA: string, domainB: string, probability: number): void {
    this.conflict_probability_cache[makeConflictKey(domainA, domainB)] = probability
  }

  getConflictProbability(domainA: string, domainB: string): number {
    return this.conflict_probability_cache[makeConflictKey(domainA, domainB)] ?? 0
  }

  toJSON(): TaskGraphData {
    return {
      tasks: this.tasks,
      conflict_probability_cache: this.conflict_probability_cache,
      changed: this.changed,
    }
  }

  static fromJSON(json: TaskGraphData): TaskGraph {
    const parsed = TaskGraphSchema.parse(json)
    return new TaskGraph(parsed)
  }
}
