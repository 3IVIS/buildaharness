import { describe, it, expect, vi, afterEach } from 'vitest'
import { DEFAULT_PLAN_MODE, resolvePlanMode, normalizePlanMode } from './plan-mode-flag.js'

describe('resolvePlanMode', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('defaults to legacy when ASSISTANT_PLAN_MODE is unset (P11 rollout window)', () => {
    expect(resolvePlanMode({})).toBe('legacy')
    expect(DEFAULT_PLAN_MODE).toBe('legacy')
  })

  it('honors an explicit "gated"', () => {
    expect(resolvePlanMode({ ASSISTANT_PLAN_MODE: 'gated' })).toBe('gated')
  })

  it('honors an explicit "legacy"', () => {
    expect(resolvePlanMode({ ASSISTANT_PLAN_MODE: 'legacy' })).toBe('legacy')
  })

  it('falls back to the default and warns on an unrecognized value', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(resolvePlanMode({ ASSISTANT_PLAN_MODE: 'yes-please' })).toBe(DEFAULT_PLAN_MODE)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toContain('ASSISTANT_PLAN_MODE')
  })
})

describe('normalizePlanMode', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('treats undefined and empty string as the default (a Vite var defined but empty)', () => {
    expect(normalizePlanMode(undefined)).toBe(DEFAULT_PLAN_MODE)
    expect(normalizePlanMode('')).toBe(DEFAULT_PLAN_MODE)
  })

  it('passes "gated"/"legacy" through', () => {
    expect(normalizePlanMode('gated')).toBe('gated')
    expect(normalizePlanMode('legacy')).toBe('legacy')
  })

  it('warns with the caller-supplied var name on a typo and falls back to the default', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(normalizePlanMode('on', 'VITE_ASSISTANT_PLAN_MODE')).toBe(DEFAULT_PLAN_MODE)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toContain('VITE_ASSISTANT_PLAN_MODE')
  })
})
