import { describe, it, expect, vi } from 'vitest'
import { envOverridesFromImportMetaEnv, ENV_VAR_FOR_CONFIG_KEY } from './browser-config'
import { DEFAULT_ONE_LOOP_MODE, DEFAULT_GOAL_GRAPH_MODE, DEFAULT_GOAL_GRAPH_SUGGEST_MODE } from '@buildaharness/aielia'

/** A minimal ImportMetaEnv stand-in — the real one has an index signature, so this is enough. */
function env(overrides: Record<string, string>): ImportMetaEnv {
  return { ...overrides } as unknown as ImportMetaEnv
}

describe('envOverridesFromImportMetaEnv', () => {
  it('returns {} when no VITE_ASSISTANT_* vars are set', () => {
    expect(envOverridesFromImportMetaEnv(env({}))).toEqual({})
  })

  it('only maps a key when its build-time var is actually non-empty', () => {
    expect(envOverridesFromImportMetaEnv(env({ VITE_ASSISTANT_PROXY_URL: '' }))).toEqual({})
    expect(envOverridesFromImportMetaEnv(env({ VITE_ASSISTANT_PROXY_URL: 'https://proxy.example' }))).toEqual({
      proxyUrl: 'https://proxy.example',
    })
  })

  it('reads the proxy URL / token / model vars', () => {
    expect(
      envOverridesFromImportMetaEnv(
        env({
          VITE_ASSISTANT_PROXY_URL: 'https://proxy.example',
          VITE_ASSISTANT_PROXY_TOKEN: 'tok',
          VITE_ASSISTANT_MODEL: 'claude-sonnet-5',
        }),
      ),
    ).toEqual({ proxyUrl: 'https://proxy.example', authToken: 'tok', model: 'claude-sonnet-5' })
  })

  it('resolves VITE_ASSISTANT_ONE_LOOP into oneLoopMode', () => {
    expect(envOverridesFromImportMetaEnv(env({ VITE_ASSISTANT_ONE_LOOP: 'enabled' }))).toEqual({ oneLoopMode: 'enabled' })
    expect(envOverridesFromImportMetaEnv(env({ VITE_ASSISTANT_ONE_LOOP: 'disabled' }))).toEqual({ oneLoopMode: 'disabled' })
  })

  it('an unset or empty VITE_ASSISTANT_ONE_LOOP leaves oneLoopMode absent (PersonalAssistant owns the default)', () => {
    expect(envOverridesFromImportMetaEnv(env({}))).not.toHaveProperty('oneLoopMode')
    expect(envOverridesFromImportMetaEnv(env({ VITE_ASSISTANT_ONE_LOOP: '' }))).not.toHaveProperty('oneLoopMode')
  })

  it('a typo\'d VITE_ASSISTANT_ONE_LOOP warns and falls back to the default', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(envOverridesFromImportMetaEnv(env({ VITE_ASSISTANT_ONE_LOOP: 'on' }))).toEqual({ oneLoopMode: DEFAULT_ONE_LOOP_MODE })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('VITE_ASSISTANT_ONE_LOOP')
    warn.mockRestore()
  })

  it('advertises VITE_ASSISTANT_ONE_LOOP as the pinning var for oneLoopMode', () => {
    expect(ENV_VAR_FOR_CONFIG_KEY.oneLoopMode).toBe('VITE_ASSISTANT_ONE_LOOP')
  })

  it('resolves VITE_ASSISTANT_GOAL_GRAPH into goalGraphMode', () => {
    expect(envOverridesFromImportMetaEnv(env({ VITE_ASSISTANT_GOAL_GRAPH: 'enabled' }))).toEqual({ goalGraphMode: 'enabled' })
    expect(envOverridesFromImportMetaEnv(env({ VITE_ASSISTANT_GOAL_GRAPH: 'disabled' }))).toEqual({ goalGraphMode: 'disabled' })
  })

  it('an unset or empty VITE_ASSISTANT_GOAL_GRAPH leaves goalGraphMode absent (PersonalAssistant owns the default)', () => {
    expect(envOverridesFromImportMetaEnv(env({}))).not.toHaveProperty('goalGraphMode')
    expect(envOverridesFromImportMetaEnv(env({ VITE_ASSISTANT_GOAL_GRAPH: '' }))).not.toHaveProperty('goalGraphMode')
  })

  it('a typo\'d VITE_ASSISTANT_GOAL_GRAPH warns and falls back to the default', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(envOverridesFromImportMetaEnv(env({ VITE_ASSISTANT_GOAL_GRAPH: 'on' }))).toEqual({ goalGraphMode: DEFAULT_GOAL_GRAPH_MODE })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('VITE_ASSISTANT_GOAL_GRAPH')
    warn.mockRestore()
  })

  it('advertises VITE_ASSISTANT_GOAL_GRAPH as the pinning var for goalGraphMode', () => {
    expect(ENV_VAR_FOR_CONFIG_KEY.goalGraphMode).toBe('VITE_ASSISTANT_GOAL_GRAPH')
  })

  it('resolves VITE_ASSISTANT_GOAL_GRAPH_SUGGEST into goalGraphSuggestMode', () => {
    expect(envOverridesFromImportMetaEnv(env({ VITE_ASSISTANT_GOAL_GRAPH_SUGGEST: 'enabled' }))).toEqual({ goalGraphSuggestMode: 'enabled' })
    expect(envOverridesFromImportMetaEnv(env({ VITE_ASSISTANT_GOAL_GRAPH_SUGGEST: 'disabled' }))).toEqual({ goalGraphSuggestMode: 'disabled' })
  })

  it('an unset or empty VITE_ASSISTANT_GOAL_GRAPH_SUGGEST leaves goalGraphSuggestMode absent', () => {
    expect(envOverridesFromImportMetaEnv(env({}))).not.toHaveProperty('goalGraphSuggestMode')
    expect(envOverridesFromImportMetaEnv(env({ VITE_ASSISTANT_GOAL_GRAPH_SUGGEST: '' }))).not.toHaveProperty('goalGraphSuggestMode')
  })

  it('a typo\'d VITE_ASSISTANT_GOAL_GRAPH_SUGGEST warns and falls back to the default', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(envOverridesFromImportMetaEnv(env({ VITE_ASSISTANT_GOAL_GRAPH_SUGGEST: 'on' }))).toEqual({
      goalGraphSuggestMode: DEFAULT_GOAL_GRAPH_SUGGEST_MODE,
    })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('VITE_ASSISTANT_GOAL_GRAPH_SUGGEST')
    warn.mockRestore()
  })

  it('advertises VITE_ASSISTANT_GOAL_GRAPH_SUGGEST as the pinning var for goalGraphSuggestMode', () => {
    expect(ENV_VAR_FOR_CONFIG_KEY.goalGraphSuggestMode).toBe('VITE_ASSISTANT_GOAL_GRAPH_SUGGEST')
  })
})
