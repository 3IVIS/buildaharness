import { describe, it, expect, vi, afterEach } from 'vitest'
import { DEFAULT_ONE_LOOP_MODE, resolveOneLoopMode } from './one-loop-flag.js'

describe('resolveOneLoopMode', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('defaults to disabled when ASSISTANT_ONE_LOOP is unset', () => {
    expect(resolveOneLoopMode({})).toBe('disabled')
    expect(DEFAULT_ONE_LOOP_MODE).toBe('disabled')
  })

  it('honors an explicit "enabled"', () => {
    expect(resolveOneLoopMode({ ASSISTANT_ONE_LOOP: 'enabled' })).toBe('enabled')
  })

  it('honors an explicit "disabled"', () => {
    expect(resolveOneLoopMode({ ASSISTANT_ONE_LOOP: 'disabled' })).toBe('disabled')
  })

  it('falls back to the default and warns on an unrecognized value', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(resolveOneLoopMode({ ASSISTANT_ONE_LOOP: 'yes-please' })).toBe('disabled')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toContain('ASSISTANT_ONE_LOOP')
  })
})
