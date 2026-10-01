import { describe, it, expect } from 'vitest'
import { HarnessRuntime, type HarnessRunOptions } from './harness-runtime.js'
import type { Task } from './state/task-graph.js'

// hookEnabled: the host's per-call gate on its semantic escalation hooks. False ⇒ that call behaves as if the hook were not
// supplied; absent or throwing ⇒ the hook runs.

const task: Task = {
  id: 't1', description: 'Answer the question', status: 'PENDING', risk_level: 'LOW',
  depends_on: [], parallel_write_domains: [], abstraction_level: 1, assigned_strategy: null,
}
const match = { failure_class: 'TOOL_UNAVAILABLE_CASCADE', confidence: 0.9, matched_pattern: 'tool-unavailable-cascade' }

async function run(hookEnabled: HarnessRunOptions['hookEnabled']) {
  let calls = 0
  let matcherCalls = 0
  const switches: unknown[] = []
  const out = await new HarnessRuntime().run('answer', ['answered'], {
    initialTasks: [{ ...task }],
    max_steps: 8,
    toolExecutors: { default: () => { calls++; if (calls === 1) throw new Error('API Error: 503 service unavailable'); return 'The answer is 42.' } },
    semanticFailureMatcher: async () => { matcherCalls++; return match as never },
    onFailureModeSwitch: (e) => switches.push(e),
    ...(hookEnabled ? { hookEnabled } : {}),
  })
  if (out.status !== 'complete') throw new Error('expected a complete run')
  return { matcherCalls, switches, calls }
}

describe('hookEnabled', () => {
  it('no gate: the hook runs (today)', async () => {
    const r = await run(undefined)
    expect(r.matcherCalls).toBeGreaterThan(0)
    expect(r.switches).toHaveLength(1)
  })

  it('a gate that says no: the hook is not called and no curated switch happens', async () => {
    const asked: string[] = []
    const r = await run((layer) => { asked.push(layer); return false })
    expect(r.matcherCalls).toBe(0)
    expect(r.switches).toHaveLength(0)
    expect(asked).toContain('failure_match')
  })

  it('a gate that says yes: the hook runs', async () => {
    const r = await run((layer) => layer === 'failure_match')
    expect(r.matcherCalls).toBeGreaterThan(0)
    expect(r.switches).toHaveLength(1)
  })

  it('a throwing gate keeps the hook running', async () => {
    const r = await run(() => { throw new Error('boom') })
    expect(r.matcherCalls).toBeGreaterThan(0)
  })
})
