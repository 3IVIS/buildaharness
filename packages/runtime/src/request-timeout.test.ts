import { describe, it, expect } from 'vitest'

describe('linkAbortSignal', () => {
  it('aborts the controller when the caller aborts, or at once if it already has', async () => {
    const { linkAbortSignal } = await import('./request-timeout')
    const caller = new AbortController()
    const c1 = new AbortController()
    linkAbortSignal(c1, caller.signal)
    expect(c1.signal.aborted).toBe(false)
    caller.abort()
    expect(c1.signal.aborted).toBe(true)
    const c2 = new AbortController()
    linkAbortSignal(c2, caller.signal)
    expect(c2.signal.aborted).toBe(true)
    const c3 = new AbortController()
    linkAbortSignal(c3, undefined)
    expect(c3.signal.aborted).toBe(false)
  })
})
