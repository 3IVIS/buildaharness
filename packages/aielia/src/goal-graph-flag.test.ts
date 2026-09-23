import { describe, it, expect, vi, afterEach } from 'vitest'
import { DEFAULT_GOAL_GRAPH_MODE, resolveGoalGraphMode, normalizeGoalGraphMode, isGoalGraphEnabled } from './goal-graph-flag.js'

describe('resolveGoalGraphMode', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('defaults to enabled (as of 2026-09-23) when ASSISTANT_GOAL_GRAPH is unset', () => {
    expect(resolveGoalGraphMode({})).toBe('enabled')
    expect(DEFAULT_GOAL_GRAPH_MODE).toBe('enabled')
  })

  it('isGoalGraphEnabled: undefined falls back to the package default; an explicit "disabled" is the escape hatch', () => {
    expect(isGoalGraphEnabled(undefined)).toBe(true)
    expect(isGoalGraphEnabled('enabled')).toBe(true)
    expect(isGoalGraphEnabled('disabled')).toBe(false)
  })

  it('an explicit "disabled" is honored', () => {
    expect(resolveGoalGraphMode({ ASSISTANT_GOAL_GRAPH: 'disabled' })).toBe('disabled')
  })

  it('honors an explicit "enabled"', () => {
    expect(resolveGoalGraphMode({ ASSISTANT_GOAL_GRAPH: 'enabled' })).toBe('enabled')
  })

  it('honors an explicit "disabled"', () => {
    expect(resolveGoalGraphMode({ ASSISTANT_GOAL_GRAPH: 'disabled' })).toBe('disabled')
  })

  it('falls back to the default and warns on an unrecognized value', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(resolveGoalGraphMode({ ASSISTANT_GOAL_GRAPH: 'yes-please' })).toBe(DEFAULT_GOAL_GRAPH_MODE)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toContain('ASSISTANT_GOAL_GRAPH')
  })
})

describe('normalizeGoalGraphMode', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('treats undefined and empty string as the default (a Vite var defined but empty)', () => {
    expect(normalizeGoalGraphMode(undefined)).toBe(DEFAULT_GOAL_GRAPH_MODE)
    expect(normalizeGoalGraphMode('')).toBe(DEFAULT_GOAL_GRAPH_MODE)
  })

  it('passes "enabled"/"disabled" through', () => {
    expect(normalizeGoalGraphMode('enabled')).toBe('enabled')
    expect(normalizeGoalGraphMode('disabled')).toBe('disabled')
  })

  it('warns with the caller-supplied var name on a typo and falls back to the default', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(normalizeGoalGraphMode('on', 'VITE_ASSISTANT_GOAL_GRAPH')).toBe(DEFAULT_GOAL_GRAPH_MODE)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toContain('VITE_ASSISTANT_GOAL_GRAPH')
  })
})
