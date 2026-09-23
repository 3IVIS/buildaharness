import { describe, it, expect, vi, afterEach } from 'vitest'
import { DEFAULT_GOAL_GRAPH_SUGGEST_MODE, resolveGoalGraphSuggestMode, normalizeGoalGraphSuggestMode } from './goal-graph-suggest-flag.js'

describe('resolveGoalGraphSuggestMode', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('defaults to disabled when ASSISTANT_GOAL_GRAPH_SUGGEST is unset', () => {
    expect(resolveGoalGraphSuggestMode({})).toBe('disabled')
    expect(DEFAULT_GOAL_GRAPH_SUGGEST_MODE).toBe('disabled')
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
