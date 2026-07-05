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
})
export type Task = z.infer<typeof TaskSchema>

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
