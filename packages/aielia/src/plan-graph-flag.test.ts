import { describe, it, expect, vi, afterEach } from 'vitest'
import { DEFAULT_PLAN_GRAPH_MODE, resolvePlanGraphMode, normalizePlanGraphMode, isPlanGraphEnabled } from './plan-graph-flag.js'

describe('resolvePlanGraphMode', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('defaults to disabled when ASSISTANT_PLAN_GRAPH is unset', () => {
    expect(resolvePlanGraphMode({})).toBe('disabled')
    expect(DEFAULT_PLAN_GRAPH_MODE).toBe('disabled')
  })

  it('isPlanGraphEnabled: undefined falls back to the package default', () => {
    expect(isPlanGraphEnabled(undefined)).toBe(false)
    expect(isPlanGraphEnabled('disabled')).toBe(false)
    expect(isPlanGraphEnabled('enabled')).toBe(true)
  })

  it('honors an explicit "enabled" and "disabled"', () => {
    expect(resolvePlanGraphMode({ ASSISTANT_PLAN_GRAPH: 'enabled' })).toBe('enabled')
    expect(resolvePlanGraphMode({ ASSISTANT_PLAN_GRAPH: 'disabled' })).toBe('disabled')
  })

  it('falls back to the default and warns on an unrecognized value', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(resolvePlanGraphMode({ ASSISTANT_PLAN_GRAPH: 'yes-please' })).toBe(DEFAULT_PLAN_GRAPH_MODE)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toContain('ASSISTANT_PLAN_GRAPH')
  })
})

describe('normalizePlanGraphMode', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('treats undefined and empty string as the default', () => {
    expect(normalizePlanGraphMode(undefined)).toBe(DEFAULT_PLAN_GRAPH_MODE)
    expect(normalizePlanGraphMode('')).toBe(DEFAULT_PLAN_GRAPH_MODE)
  })

  it('passes "enabled"/"disabled" through', () => {
    expect(normalizePlanGraphMode('enabled')).toBe('enabled')
    expect(normalizePlanGraphMode('disabled')).toBe('disabled')
  })

  it('warns with the caller-supplied var name on a typo and falls back to the default', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(normalizePlanGraphMode('on', 'VITE_ASSISTANT_PLAN_GRAPH')).toBe(DEFAULT_PLAN_GRAPH_MODE)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toContain('VITE_ASSISTANT_PLAN_GRAPH')
  })
})
