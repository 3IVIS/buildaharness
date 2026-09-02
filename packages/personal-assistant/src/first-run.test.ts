import { describe, it, expect, vi } from 'vitest'
import { maybeRunFirstRunSetup, type FirstRunDeps } from './first-run.js'
import type { AssistantConfig } from './config.js'

function makeDeps(overrides: Partial<FirstRunDeps> = {}): FirstRunDeps & { saved: Partial<AssistantConfig>[] } {
  const saved: Partial<AssistantConfig>[] = []
  const deps: FirstRunDeps & { saved: Partial<AssistantConfig>[] } = {
    saved,
    configStore: {
      load: async () => ({}),
      save: async (patch) => {
        saved.push(patch)
      },
    },
    persisted: {},
    overriddenKeys: new Set(),
    isInteractive: true,
    ask: async () => '',
    detectClaudeCli: async () => false,
    log: () => {},
    ...overrides,
  }
  return deps
}

describe('maybeRunFirstRunSetup', () => {
  it('skips when a backend is already persisted', async () => {
    const deps = makeDeps({ persisted: { llmBackend: 'anthropic', apiKey: 'sk-ant-x' } })
    const ask = vi.fn()
    deps.ask = ask
    const result = await maybeRunFirstRunSetup(deps)
    expect(ask).not.toHaveBeenCalled()
    expect(deps.saved).toEqual([])
    expect(result).toBe(deps.persisted)
  })

  it('skips when a backend key is pinned by an env var', async () => {
    const deps = makeDeps({ overriddenKeys: new Set(['llmBackend']) })
    const ask = vi.fn()
    deps.ask = ask
    await maybeRunFirstRunSetup(deps)
    expect(ask).not.toHaveBeenCalled()
  })

  it('skips entirely for non-interactive stdin', async () => {
    const deps = makeDeps({ isInteractive: false })
    const ask = vi.fn()
    deps.ask = ask
    await maybeRunFirstRunSetup(deps)
    expect(ask).not.toHaveBeenCalled()
    expect(deps.saved).toEqual([])
  })

  it('adopts the claude-cli backend when the user accepts the detected binary', async () => {
    const deps = makeDeps({ detectClaudeCli: async () => true, ask: async () => '' })
    const result = await maybeRunFirstRunSetup(deps)
    expect(deps.saved).toEqual([{ llmBackend: 'claude-cli' }])
    expect(result.llmBackend).toBe('claude-cli')
  })

  it('falls through to provider selection when claude-cli is declined', async () => {
    const answers = ['n', '1', 'sk-ant-secret']
    let i = 0
    const deps = makeDeps({ detectClaudeCli: async () => true, ask: async () => answers[i++] })
    const result = await maybeRunFirstRunSetup(deps)
    expect(deps.saved).toEqual([{ llmBackend: 'anthropic', apiKey: 'sk-ant-secret' }])
    expect(result).toMatchObject({ llmBackend: 'anthropic', apiKey: 'sk-ant-secret' })
  })

  it('saves the chosen provider and key', async () => {
    const answers = ['3', 'sk-or-key']
    let i = 0
    const deps = makeDeps({ ask: async () => answers[i++] })
    await maybeRunFirstRunSetup(deps)
    expect(deps.saved).toEqual([{ llmBackend: 'openrouter', apiKey: 'sk-or-key' }])
  })

  it('leaves config untouched when the provider prompt is skipped', async () => {
    const deps = makeDeps({ ask: async () => '' })
    const result = await maybeRunFirstRunSetup(deps)
    expect(deps.saved).toEqual([])
    expect(result).toEqual({})
  })

  it('does not persist a backend when the API key is left blank', async () => {
    const answers = ['1', '']
    let i = 0
    const deps = makeDeps({ ask: async () => answers[i++] })
    await maybeRunFirstRunSetup(deps)
    expect(deps.saved).toEqual([])
  })
})
