import { describe, it, expect } from 'vitest'
import { HarnessRuntime, type HarnessRunOptions } from './harness-runtime.js'
import type { Task } from './state/task-graph.js'

// The semantic failure matcher must get to classify a task's FIRST failure. failure_history is written by rollbackAndReplan,
// which runs after the matcher block, so a guard on the history alone meant a transient error on a single-task turn was
// only ever matched after the turn had already been given up on.

const task: Task = {
  id: 't1', description: 'Answer the question', status: 'PENDING', risk_level: 'LOW',
  depends_on: [], parallel_write_domains: [], abstraction_level: 1, assigned_strategy: null,
}
const GAVE_UP = /couldn't complete this/
const match = { failure_class: 'TOOL_UNAVAILABLE_CASCADE', confidence: 0.9, matched_pattern: 'tool-unavailable-cascade' }

async function run(failFirst: boolean, matcher: HarnessRunOptions['semanticFailureMatcher']) {
  let calls = 0
  const switches: unknown[] = []
  const out = await new HarnessRuntime().run('answer', ['answered'], {
    initialTasks: [{ ...task }],
    max_steps: 8,
    toolExecutors: { default: () => { calls++; if (failFirst && calls === 1) throw new Error('API Error: 503 service unavailable'); return 'The answer is 42.' } },
    semanticFailureMatcher: matcher,
    onFailureModeSwitch: (e) => switches.push(e),
  })
  if (out.status !== 'complete') throw new Error('expected a complete run')
  return { calls, switches, reply: String(out.result.finalResult) }
}

describe('semanticFailureMatcher on the first failure', () => {
  it('a transient error is classified, the curated strategy is chosen and the task is retried to success', async () => {
    const seen: string[][] = []
    const r = await run(true, async (symptoms) => { seen.push(symptoms); return match as never })
    expect(seen[0]).toEqual(['SYSTEM_ERROR: API Error: 503 service unavailable'])
    expect(r.switches).toEqual([{ taskId: 't1', failure_class: 'TOOL_UNAVAILABLE_CASCADE', strategy: 'REIMPLEMENT' }])
    expect(r.calls).toBe(2)
    expect(r.reply).toBe('The answer is 42.')
  })

  it('negative control — no matcher wired: the same single failure is not retried and the turn gives up', async () => {
    const r = await run(true, undefined)
    expect(r.calls).toBe(1)
    expect(r.reply).toMatch(GAVE_UP)
    expect(r.switches).toEqual([])
  })

  it('a matcher that finds nothing leaves the old behaviour (gives up after the one failure)', async () => {
    const r = await run(true, async () => null)
    expect(r.calls).toBe(1)
    expect(r.reply).toMatch(GAVE_UP)
  })

  it('a turn with no failure never calls the matcher', async () => {
    let called = 0
    const r = await run(false, async () => { called++; return match as never })
    expect(called).toBe(0)
    expect(r.reply).toBe('The answer is 42.')
    expect(r.calls).toBe(1)
  })
})

describe('the matcher is only asked about a failing task, and once a match is produced not again for that task', () => {
  const t = (id: string, depends_on: string[] = []): Task => ({ ...task, id, description: `task ${id}`, depends_on })

  async function runGraph(failures: number, matcher: HarnessRunOptions['semanticFailureMatcher'], retryFailedTask = false) {
    let calls = 0
    await new HarnessRuntime().run('answer', ['answered'], {
      initialTasks: [t('1'), t('2'), t('3', ['1', '2'])],
      max_steps: 20,
      retryFailedTask,
      toolExecutors: { default: () => { calls++; if (calls <= failures) throw new Error(`API Error: 503 service unavailable (try ${calls})`); return `ok ${calls}` } },
      semanticFailureMatcher: matcher,
    })
  }

  it('a recovered decomposed turn asks once, not once per remaining task (it used to ask on every iteration after the first failure)', async () => {
    let asked = 0
    await runGraph(1, async () => { asked++; return match as never })
    expect(asked).toBe(1)
  })

  it('a matcher that found nothing is asked again when the same task fails again (the later-pass behaviour is kept)', async () => {
    let asked = 0
    await runGraph(2, async () => { asked++; return null }, true)
    expect(asked).toBeGreaterThan(1)
  })
})
