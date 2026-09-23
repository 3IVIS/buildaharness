import { describe, it, expect, vi, afterEach } from 'vitest'
import { DEFAULT_GOAL_GRAPH_SUGGEST_MODE, resolveGoalGraphSuggestMode, normalizeGoalGraphSuggestMode, isGoalGraphSuggestEnabled } from './goal-graph-suggest-flag.js'

describe('resolveGoalGraphSuggestMode', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('defaults to enabled (as of 2026-09-23) when ASSISTANT_GOAL_GRAPH_SUGGEST is unset', () => {
    expect(resolveGoalGraphSuggestMode({})).toBe('enabled')
    expect(DEFAULT_GOAL_GRAPH_SUGGEST_MODE).toBe('enabled')
  })

  it('isGoalGraphSuggestEnabled: undefined falls back to the package default; an explicit "disabled" is the escape hatch', () => {
    expect(isGoalGraphSuggestEnabled(undefined)).toBe(true)
    expect(isGoalGraphSuggestEnabled('enabled')).toBe(true)
    expect(isGoalGraphSuggestEnabled('disabled')).toBe(false)
  })

  it('an explicit "disabled" is honored', () => {
    expect(resolveGoalGraphSuggestMode({ ASSISTANT_GOAL_GRAPH_SUGGEST: 'disabled' })).toBe('disabled')
  })

  it('honors an explicit "enabled"', () => {
    expect(resolveGoalGraphSuggestMode({ ASSISTANT_GOAL_GRAPH_SUGGEST: 'enabled' })).toBe('enabled')
  })

  it('honors an explicit "disabled"', () => {
    expect(resolveGoalGraphSuggestMode({ ASSISTANT_GOAL_GRAPH_SUGGEST: 'disabled' })).toBe('disabled')
  })

  it('falls back to the default and warns on an unrecognized value', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(resolveGoalGraphSuggestMode({ ASSISTANT_GOAL_GRAPH_SUGGEST: 'yes-please' })).toBe(DEFAULT_GOAL_GRAPH_SUGGEST_MODE)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toContain('ASSISTANT_GOAL_GRAPH_SUGGEST')
  })
})

describe('normalizeGoalGraphSuggestMode', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('treats undefined and empty string as the default (a Vite var defined but empty)', () => {
    expect(normalizeGoalGraphSuggestMode(undefined)).toBe(DEFAULT_GOAL_GRAPH_SUGGEST_MODE)
    expect(normalizeGoalGraphSuggestMode('')).toBe(DEFAULT_GOAL_GRAPH_SUGGEST_MODE)
  })

  it('passes "enabled"/"disabled" through', () => {
    expect(normalizeGoalGraphSuggestMode('enabled')).toBe('enabled')
    expect(normalizeGoalGraphSuggestMode('disabled')).toBe('disabled')
  })

  it('warns with the caller-supplied var name on a typo and falls back to the default', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(normalizeGoalGraphSuggestMode('on', 'VITE_ASSISTANT_GOAL_GRAPH_SUGGEST')).toBe(DEFAULT_GOAL_GRAPH_SUGGEST_MODE)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toContain('VITE_ASSISTANT_GOAL_GRAPH_SUGGEST')
  })
})
