import { describe, it, expect } from 'vitest'
import { HarnessRuntime, type HarnessRunOptions } from './harness-runtime.js'
import { EscalationHalt } from './nodes/escalate.js'
import type { Task } from './state/task-graph.js'

// The review_failure escalation site: a proposed change that fails review twice in a row for the same task halts the run.
// With ask mode on and MORE THAN ONE dimension failing, the halt is a structured "which fix should I apply?" question. Until
// the review gate collected every failing dimension (as its Python twin does) the site could only ever see one failing
// dimension and so could never offer that question.

// The task's own description is what the review checks: it removes a required section AND mentions invalid code.
const task: Task = {
  id: 't1', description: 'remove summary and fix the invalid code', status: 'PENDING', risk_level: 'LOW',
  depends_on: [], parallel_write_domains: [], abstraction_level: 1, assigned_strategy: null,
}

const twoFailingDimensions = (over: Partial<HarnessRunOptions>): HarnessRunOptions => ({
  initialTasks: [{ ...task }],
  max_steps: 10,
  toolConfigs: { linter: { available: true } }, // code_quality only runs when a linter exists
  outputContract: { required_sections: ['summary'] }, // 'remove summary' removes a required section
  toolExecutors: { default: () => 'never reached — the change is blocked at review' },
  ...over,
})

async function halt(over: Partial<HarnessRunOptions>): Promise<EscalationHalt> {
  try {
    await new HarnessRuntime().run('fix the report', ['report fixed'], twoFailingDimensions(over))
  } catch (e) {
    if (e instanceof EscalationHalt) return e
    throw e
  }
  throw new Error('expected an EscalationHalt')
}

describe('review_failure escalation', () => {
  it('ask mode on: two failing dimensions become a structured question with one fix option per dimension', async () => {
    const h = await halt({ askMode: 'enabled' })
    expect(h.blocker.reason).toBe('review_failure')
    const q = h.blocker.questions?.[0]
    expect(q?.id).toBe('review-failure-resolution')
    expect(q?.options?.map((o) => o.label)).toEqual([
      'Adjust the proposed change to satisfy the output contract',
      'Address the code-quality issue before proceeding',
    ])
  })

  it('ask mode off: the same halt is the plain missing_info escalation, byte-for-byte as before, with every failing reason listed', async () => {
    const h = await halt({ askMode: 'disabled' })
    expect(h.blocker.reason).toBe('review_failure')
    expect(h.blocker.questions).toBeUndefined()
    expect(h.blocker.missing_info).toHaveLength(2)
  })

  it('a single failing dimension still falls back to the plain halt even with ask mode on (no discrete option set)', async () => {
    const h = await halt({ askMode: 'enabled', toolConfigs: {} }) // no linter -> code_quality is skipped
    expect(h.blocker.reason).toBe('review_failure')
    expect(h.blocker.questions).toBeUndefined()
    expect(h.blocker.missing_info).toHaveLength(1)
  })
})
