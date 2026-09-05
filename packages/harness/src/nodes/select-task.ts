// Policy primitive (Phase H, ADR-003 F-2): decides the next task from ControlState +
// TaskGraph structure alone. Parallel-branch reconciliation (State) lives in
// ./parallel-merge.ts, not here — the two used to share this file.
import type { ControlState } from '../state/control-state.js'
import { TaskGraph, type Task } from '../state/task-graph.js'

export const PESSIMISTIC_THRESHOLD = 0.5

export interface SelectTaskResult {
  task: Task | null
  concurrentTask: Task | null
  escalate: boolean
}

export function selectTask(taskGraph: TaskGraph, controlState: ControlState): SelectTaskResult {
  if (controlState.escalation_reason === 'HUMAN_REQUIRED') {
    return { task: null, concurrentTask: null, escalate: true }
  }

  const taskMap = new Map(taskGraph.tasks.map(t => [t.id, t]))
  const eligible = taskGraph.tasks.filter(t => {
    if (t.status !== 'PENDING') return false
    return t.depends_on.every(depId => taskMap.get(depId)?.status === 'COMPLETE')
  })

  if (eligible.length === 0) return { task: null, concurrentTask: null, escalate: false }

  const riskOrder: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 }
  const sorted = [...eligible].sort((a, b) => (riskOrder[a.risk_level] ?? 1) - (riskOrder[b.risk_level] ?? 1))

  const primary = sorted[0]
  if (sorted.length < 2) return { task: primary, concurrentTask: null, escalate: false }

  const secondary = sorted[1]
  const primaryDomains = new Set(primary.parallel_write_domains)
  const hasOverlap = secondary.parallel_write_domains.some(d => primaryDomains.has(d))

  if (!hasOverlap) return { task: primary, concurrentTask: secondary, escalate: false }

  // Overlapping write domains: consult conflict_probability_cache
  const conflictProb = Math.max(
    0,
    ...primary.parallel_write_domains.flatMap(da =>
      secondary.parallel_write_domains.map(db => taskGraph.getConflictProbability(da, db)),
    ),
  )

  if (conflictProb > PESSIMISTIC_THRESHOLD) {
    return { task: primary, concurrentTask: null, escalate: false }
  }
  return { task: primary, concurrentTask: secondary, escalate: false }
}
