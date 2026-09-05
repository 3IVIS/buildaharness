import { describe, it, expect, vi } from 'vitest'
import { envOverridesFromImportMetaEnv, ENV_VAR_FOR_CONFIG_KEY } from './browser-config'

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

  it('a typo\'d VITE_ASSISTANT_ONE_LOOP warns and falls back to "disabled"', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(envOverridesFromImportMetaEnv(env({ VITE_ASSISTANT_ONE_LOOP: 'on' }))).toEqual({ oneLoopMode: 'disabled' })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('VITE_ASSISTANT_ONE_LOOP')
    warn.mockRestore()
  })

  it('advertises VITE_ASSISTANT_ONE_LOOP as the pinning var for oneLoopMode', () => {
    expect(ENV_VAR_FOR_CONFIG_KEY.oneLoopMode).toBe('VITE_ASSISTANT_ONE_LOOP')
  })
})
