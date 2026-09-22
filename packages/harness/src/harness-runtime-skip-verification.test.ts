import { describe, it, expect } from 'vitest'
import { HarnessRuntime } from './harness-runtime.js'
import type { VerificationResult } from './nodes/verify.js'
import type { Task } from './state/task-graph.js'

// Feature-value audit, Phase C5 — `skipVerification` is an eval-only ablation seam. Default
// (absent) must leave verify() + onVerification exactly as they were.

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

async function runOnce(skipVerification?: boolean) {
  const seen: VerificationResult[] = []
  const layers: Array<{ layer: string; fired: boolean; reason: string }> = []
  const outcome = await new HarnessRuntime().run('do a thing', ['done'], {
    initialTasks: [makeTask('t1')],
    max_steps: 10,
    toolExecutors: { default: () => 'result' },
    onVerification: (r) => seen.push(r),
    onLayerActivity: (e) => layers.push(e),
    ...(skipVerification === undefined ? {} : { skipVerification }),
  })
  return { outcome, seen, layers }
}

describe('HarnessRunOptions.skipVerification (Phase C5, eval-only)', () => {
  it('default (absent): verify() runs and onVerification fires', async () => {
    const { outcome, seen, layers } = await runOnce()
    expect(outcome.status).toBe('complete')
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(seen[0].layer_results.length).toBeGreaterThan(0)
    expect(layers.find((l) => l.layer === 'verification')?.fired).toBe(true)
  })

  it('explicit false is identical to absent', async () => {
    const { seen } = await runOnce(false)
    expect(seen.length).toBeGreaterThanOrEqual(1)
  })

  it('true: verify() is skipped, onVerification never fires, and the turn still completes', async () => {
    const { outcome, seen, layers } = await runOnce(true)
    expect(outcome.status).toBe('complete')
    expect(seen).toHaveLength(0)
    const v = layers.find((l) => l.layer === 'verification')
    expect(v?.fired).toBe(false)
    expect(v?.reason).toContain('skipped')
  })
})
