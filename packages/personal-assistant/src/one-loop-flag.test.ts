import { describe, it, expect, vi, afterEach } from 'vitest'
import { DEFAULT_ONE_LOOP_MODE, resolveOneLoopMode, normalizeOneLoopMode } from './one-loop-flag.js'

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

describe('normalizeOneLoopMode', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('treats undefined and empty string as the default (a Vite var defined but empty)', () => {
    expect(normalizeOneLoopMode(undefined)).toBe('disabled')
    expect(normalizeOneLoopMode('')).toBe('disabled')
  })

  it('passes "enabled"/"disabled" through', () => {
    expect(normalizeOneLoopMode('enabled')).toBe('enabled')
    expect(normalizeOneLoopMode('disabled')).toBe('disabled')
  })

  it('warns with the caller-supplied var name on a typo and falls back to the default', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(normalizeOneLoopMode('on', 'VITE_ASSISTANT_ONE_LOOP')).toBe('disabled')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toContain('VITE_ASSISTANT_ONE_LOOP')
  })
})
