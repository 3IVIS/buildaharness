import { describe, it, expect, vi } from 'vitest'
import { wrapProposerWithInjectedFailure } from './benchmark-injected-failure.js'
import type { ToolExecutorContext } from '@buildaharness/harness'

function fakeCtx(): ToolExecutorContext {
  return {
    worldModel: { observations: [] } as unknown as ToolExecutorContext['worldModel'],
    evidenceStore: {} as ToolExecutorContext['evidenceStore'],
    failureDiagnostics: {
      failure_history: [],
      matched_pattern: null,
    } as unknown as ToolExecutorContext['failureDiagnostics'],
  }
}

describe('wrapProposerWithInjectedFailure', () => {
  it('seeds recurring failure records + a matched pattern on the first call, then reports a failed execution', async () => {
    const real = vi.fn(async () => ({ __harnessExecutionStatus: 'complete', output: 'real answer' }))
    const wrapped = wrapProposerWithInjectedFailure(real, { failIterations: 1, seedFailures: 3 })
    const ctx = fakeCtx()

    const first = await wrapped(ctx)

    expect(first).toEqual({ __harnessExecutionStatus: 'failed', error: expect.stringContaining('injected') })
    expect(ctx.failureDiagnostics!.failure_history).toHaveLength(3)
    expect(new Set(ctx.failureDiagnostics!.failure_history.map((f) => f.failure_class)).size).toBe(1)
    expect(ctx.failureDiagnostics!.matched_pattern?.failure_class).toBe(
      ctx.failureDiagnostics!.failure_history[0].failure_class,
    )
    expect(real).not.toHaveBeenCalled()
  })

  it('delegates to the real proposer once past failIterations, then replays that result from cache', async () => {
    const real = vi.fn(async () => ({ __harnessExecutionStatus: 'complete', output: 'real answer' }))
    const wrapped = wrapProposerWithInjectedFailure(real, { failIterations: 1, seedFailures: 3 })
    const ctx = fakeCtx()

    await wrapped(ctx) // injected failure
    const second = await wrapped(ctx) // first real call
    const third = await wrapped(ctx) // replayed

    expect(real).toHaveBeenCalledTimes(1)
    expect(second).toEqual({ __harnessExecutionStatus: 'complete', output: 'real answer' })
    expect(third).toEqual({ __harnessExecutionStatus: 'complete', output: 'real answer' })
  })

  it('only seeds once, even across many calls', async () => {
    const real = vi.fn(async () => 'plain string answer')
    const wrapped = wrapProposerWithInjectedFailure(real, { failIterations: 2, seedFailures: 3 })
    const ctx = fakeCtx()

    await wrapped(ctx)
    await wrapped(ctx)
    await wrapped(ctx)

    expect(ctx.failureDiagnostics!.failure_history).toHaveLength(3)
    // a plain (non-envelope) real result is normalised into a completed execution
    expect(await wrapped(ctx)).toEqual({ __harnessExecutionStatus: 'complete', output: 'plain string answer' })
  })
})
