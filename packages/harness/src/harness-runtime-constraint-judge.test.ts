import { describe, it, expect } from 'vitest'
import { HarnessRuntime, type SemanticConstraintJudge } from './harness-runtime.js'
import { OutputContractError, outputValidation } from './nodes/output-validation.js'
import { OutputContract } from './state/output-contract.js'
import { CallerState } from './state/caller-state.js'
import type { Task } from './state/task-graph.js'
import type { UpdateChannel } from './nodes/check-caller-updates.js'

// semanticConstraintJudge: the host, not a word match, decides whether a finished reply breaks a caller constraint.

const task: Task = {
  id: 't1', description: 'Write the indentation guide', status: 'PENDING', risk_level: 'LOW',
  depends_on: [], parallel_write_domains: [], abstraction_level: 1, assigned_strategy: null,
}
const REPLY = 'I will not use tabs; spaces only.' // acknowledges the constraint — obeys it

/** Delivers the constraint once, mid-run, the way steering does. */
function channel(constraints: string[]): UpdateChannel {
  let sent = false
  return { poll: () => (sent ? null : ((sent = true), { pending_update: { current_constraints: constraints }, constraints_changed: true })) }
}

async function run(judge: SemanticConstraintJudge | undefined, reply = REPLY) {
  try {
    const outcome = await new HarnessRuntime().run('write the guide', ['guide written'], {
      initialTasks: [{ ...task }],
      max_steps: 6,
      toolExecutors: { default: () => reply },
      updateChannel: channel(['Do not use tabs']),
      semanticConstraintJudge: judge,
    })
    return { outcome, error: undefined as unknown }
  } catch (error) {
    return { outcome: undefined, error }
  }
}

describe('outputValidation skipCallerConstraints', () => {
  const cs = new CallerState()
  cs.current_constraints = ['Do not use tabs']
  it('the lexical match throws on a reply that merely mentions the subject', () => {
    expect(() => outputValidation(REPLY, new OutputContract(), cs)).toThrow(OutputContractError)
  })
  it('skipped, the same reply passes', () => {
    expect(outputValidation(REPLY, new OutputContract(), cs, { skipCallerConstraints: true }).passed).toBe(true)
  })
})

describe('semanticConstraintJudge', () => {
  it('absent: the lexical check still applies (unchanged behaviour)', async () => {
    const r = await run(undefined)
    expect(r.error).toBeInstanceOf(OutputContractError)
  })

  it('present and says no violation: an acknowledging reply passes, and the judge saw the constraint and the reply', async () => {
    const seen: Array<{ constraints: string[]; reply: string }> = []
    const r = await run(async (i) => { seen.push(i); return { violated: [] } })
    expect(r.error).toBeUndefined()
    expect(r.outcome?.status).toBe('complete')
    expect(seen).toEqual([{ constraints: ['Do not use tabs'], reply: REPLY }])
  })

  it('present and finds a violation: validation fails with the constraint and the reason', async () => {
    const r = await run(async () => ({ violated: [{ constraint: 'Do not use tabs', reason: 'indents with a tab' }] }), 'Indent with a\ttab.')
    expect(r.error).toBeInstanceOf(OutputContractError)
    expect((r.error as OutputContractError).violations[0]).toContain('Do not use tabs')
    expect((r.error as OutputContractError).violations[0]).toContain('indents with a tab')
  })

  it('a judge that throws never fails the reply (fail-open, and the lexical match is not used as a fallback)', async () => {
    const r = await run(async () => { throw new Error('backend down') })
    expect(r.error).toBeUndefined()
    expect(r.outcome?.status).toBe('complete')
  })

  it('is not called when the caller set no constraint', async () => {
    let calls = 0
    const outcome = await new HarnessRuntime().run('write the guide', ['guide written'], {
      initialTasks: [{ ...task }], max_steps: 6, toolExecutors: { default: () => REPLY },
      semanticConstraintJudge: async () => { calls++; return { violated: [] } },
    })
    expect(outcome.status).toBe('complete')
    expect(calls).toBe(0)
  })
})
