import { describe, it, expect, afterEach, vi } from 'vitest'
import { assistantTestHooksEnabled, setAssistantTestHooks, getAssistantTestHooks } from './assistant-test-hooks'

afterEach(() => {
  vi.unstubAllEnvs()
  setAssistantTestHooks(null)
})

describe('assistant-test-hooks — production-bundle safety', () => {
  it('is enabled under the test runner (MODE === "test")', () => {
    expect(assistantTestHooksEnabled()).toBe(true)
  })

  it('no-ops setting hooks, and never returns them, in a production build', () => {
    vi.stubEnv('MODE', 'production')
    vi.stubEnv('VITE_E2E', '')
    expect(assistantTestHooksEnabled()).toBe(false)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setAssistantTestHooks({ makeLlmClient: () => ({}) as never })
    expect(warn).toHaveBeenCalled()
    expect(getAssistantTestHooks()).toBeNull()
    warn.mockRestore()
  })

  it('ignores window.__BAH_E2E__ in a production build', () => {
    vi.stubEnv('MODE', 'production')
    vi.stubEnv('VITE_E2E', '')
    ;(window as unknown as Record<string, unknown>).__BAH_E2E__ = { makeLlmClient: () => ({}) as never }
    try {
      expect(getAssistantTestHooks()).toBeNull()
    } finally {
      delete (window as unknown as Record<string, unknown>).__BAH_E2E__
    }
  })

  it('round-trips an in-process hook when enabled', () => {
    const hooks = { makeFsBackend: () => ({}) as never }
    setAssistantTestHooks(hooks)
    expect(getAssistantTestHooks()).toBe(hooks)
  })
})
