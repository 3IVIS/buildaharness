import { describe, it, expect } from 'vitest'
import { WorldModel } from '../state/world-model.js'
import { TaskGraph } from '../state/task-graph.js'
import { StrategyState } from '../state/strategy-state.js'
import { FailureDiagnostics } from '../state/failure-diagnostics.js'
import { CallerState } from '../state/caller-state.js'
import { InMemoryExperienceStore } from '../state/experience-store.js'
import { rollbackAndReplan, requeueFailedTask } from './rollback-replan.js'

// A confident failure-mode match re-queues the task that failed — on a decomposed turn too. The old rule ("only when nothing
// else is pending, and only a leaf") never applied to a failed root (it has dependents, and its siblings are pending), so the
// match chose a strategy for a task that was then never run again.

type Status = 'PENDING' | 'RUNNING' | 'COMPLETE' | 'FAILED'
const task = (id: string, status: Status, depends_on: string[] = []) => ({
  id, description: `task ${id}`, status, risk_level: 'LOW' as const,
  depends_on, parallel_write_domains: [] as string[], abstraction_level: 1, assigned_strategy: null,
})

/** Roots 1 and 2, task 3 depends on both — the shape the planner makes for "read two files, then summarise". */
const graph = () => new TaskGraph({ tasks: [task('1', 'FAILED'), task('2', 'PENDING'), task('3', 'PENDING', ['1', '2'])] })

function failOne(matched: boolean) {
  const fd = new FailureDiagnostics()
  if (matched) {
    fd.matched_pattern = { failure_class: 'TOOL_UNAVAILABLE_CASCADE', confidence: 0.9, matched_pattern: 'tool-unavailable-cascade', strategy_affinity: 'REIMPLEMENT' }
  }
  const g = graph()
  const failed = g.tasks.find((t) => t.id === '1')!
  const r = rollbackAndReplan(failed, new StrategyState(), fd, g, new WorldModel(), new CallerState(), new InMemoryExperienceStore(), undefined, null, false, false, false)
  return { r, status: (id: string) => r.newTaskGraph.tasks.find((t) => t.id === id)?.status }
}

describe('failure-mode match re-queues the failed task', () => {
  it('a failed root with dependents and a pending sibling goes back to PENDING', () => {
    const { r, status } = failOne(true)
    expect(r.failureModeSwitch).toEqual({ failure_class: 'TOOL_UNAVAILABLE_CASCADE', strategy: 'REIMPLEMENT' })
    expect(status('1')).toBe('PENDING')
    expect(r.newStrategyState.switch_triggers.some((t) => t.startsWith('failure_mode:requeue_task'))).toBe(true)
  })

  it('negative control — no match: the same failed root stays FAILED, stranding its dependent', () => {
    const { r, status } = failOne(false)
    expect(r.failureModeSwitch).toBeUndefined()
    expect(status('1')).toBe('FAILED')
  })
})

describe('requeueFailedTask', () => {
  it('flips only the named FAILED task', () => {
    const g = new TaskGraph({ tasks: [task('a', 'FAILED'), task('b', 'FAILED')] })
    expect(requeueFailedTask(g, 'a')).toBe(true)
    expect(g.tasks.map((t) => t.status)).toEqual(['PENDING', 'FAILED'])
  })
  it('does nothing for a missing or non-failed task', () => {
    const g = new TaskGraph({ tasks: [task('a', 'COMPLETE')] })
    expect(requeueFailedTask(g, 'a')).toBe(false)
    expect(requeueFailedTask(g, 'nope')).toBe(false)
  })
})
