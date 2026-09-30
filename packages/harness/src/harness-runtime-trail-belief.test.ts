import { describe, it, expect } from 'vitest'
import { HarnessRuntime } from './harness-runtime.js'
import type { Task } from './state/task-graph.js'

// The world-model trail belief carries what the task produced, not just that it ran, so the
// criterion-coverage hook can judge the substance instead of a bare "Completed: <task>".

const task: Task = {
  id: 't1',
  description: 'Agree scope and metrics for the Q3 redesign',
  status: 'PENDING',
  risk_level: 'MEDIUM',
  depends_on: [],
  parallel_write_domains: [],
  abstraction_level: 1,
  assigned_strategy: null,
}

describe('trail belief content', () => {
  it('the coverage hook sees the produced text alongside the Completed: prefix', async () => {
    const seen: string[][] = []
    await new HarnessRuntime().run('agree scope', ['scope and metrics agreed'], {
      initialTasks: [{ ...task }],
      max_steps: 4,
      complexitySignal: { riskLevel: 'MEDIUM', taskCount: 1, hasDurablePlan: false, consequentialTools: new Set<string>() },
      toolExecutors: { default: () => 'Nothing has started yet; this is only a proposal.' },
      semanticCriterionCoverage: async (_criterion, beliefs) => {
        seen.push(beliefs.map((b) => b.statement))
        return false
      },
    })
    const trail = seen.flat().find((s) => s.startsWith('Completed: '))
    expect(trail).toBe(`Completed: ${task.description} — produced: Nothing has started yet; this is only a proposal.`)
  })
})
