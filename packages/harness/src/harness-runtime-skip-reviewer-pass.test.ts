import { describe, it, expect } from 'vitest'
import { HarnessRuntime } from './harness-runtime.js'
import type { Task } from './state/task-graph.js'

// Feature-value audit, Phase C6 — `skipReviewerPass` is an eval-only ablation seam. Default
// (absent) must leave reviewerPass()/reviewer_pass_2 exactly as they were.

function makeTask(id: string): Task {
  return {
    id,
    description: `Task ${id}`,
    status: 'PENDING',
    risk_level: 'LOW',
    depends_on: [],
    parallel_write_domains: [],
    abstraction_level: 1,
    assigned_strategy: null,
  }
}

async function runOnce(skipReviewerPass?: boolean) {
  const layers: Array<{ layer: string; fired: boolean; reason: string }> = []
  const outcome = await new HarnessRuntime().run('do a thing', ['done'], {
    initialTasks: [makeTask('t1')],
    max_steps: 10,
    toolExecutors: { default: () => 'result' },
    onLayerActivity: (e) => layers.push(e),
    ...(skipReviewerPass === undefined ? {} : { skipReviewerPass }),
  })
  return { outcome, layers }
}

describe('HarnessRunOptions.skipReviewerPass (Phase C6, eval-only)', () => {
  it('default (absent): reviewer_pass runs and is reported fired', async () => {
    const { outcome, layers } = await runOnce()
    expect(outcome.status).toBe('complete')
    if (outcome.status === 'complete') expect(outcome.result.nodeExecutionOrder).toContain('reviewer_pass')
    expect(layers.find((l) => l.layer === 'reviewer_pass')).toBeDefined()
  })

  it('explicit false is identical to absent', async () => {
    const { outcome } = await runOnce(false)
    expect(outcome.status).toBe('complete')
    if (outcome.status === 'complete') expect(outcome.result.nodeExecutionOrder).toContain('reviewer_pass')
  })

  it('true: reviewer_pass/reviewer_pass_2 never run, nodeExecutionOrder omits them, and the turn still completes', async () => {
    const { outcome, layers } = await runOnce(true)
    expect(outcome.status).toBe('complete')
    if (outcome.status === 'complete') {
      expect(outcome.result.nodeExecutionOrder).not.toContain('reviewer_pass')
      expect(outcome.result.nodeExecutionOrder).not.toContain('reviewer_pass_2')
    }
    const r = layers.find((l) => l.layer === 'reviewer_pass')
    expect(r?.fired).toBe(false)
    expect(r?.reason).toContain('skipped')
  })
})
