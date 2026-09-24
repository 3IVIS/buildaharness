import { describe, it, expect, vi } from 'vitest'
import { maybeRunFirstRunSetup, type FirstRunDeps } from './first-run.js'
import type { AssistantConfig } from './config.js'

const LONG_ANT = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz'
const LONG_OR = 'sk-or-v1-abcdefghijklmnopqrstuvwxyz0123'

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
    const answers = ['n', '2', LONG_ANT]
    let i = 0
    const deps = makeDeps({ detectClaudeCli: async () => true, ask: async () => answers[i++] })
    const result = await maybeRunFirstRunSetup(deps)
    expect(deps.saved).toEqual([{ llmBackend: 'anthropic', apiKey: LONG_ANT }])
    expect(result).toMatchObject({ llmBackend: 'anthropic', apiKey: LONG_ANT })
  })

  it('saves the chosen provider and key', async () => {
    const answers = ['1', LONG_OR]
    let i = 0
    const deps = makeDeps({ ask: async () => answers[i++] })
    await maybeRunFirstRunSetup(deps)
    expect(deps.saved).toEqual([{ llmBackend: 'openrouter', apiKey: LONG_OR }])
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

  it('re-prompts after a key with the wrong prefix, then accepts a good one', async () => {
    const answers = ['2', 'sk-or-v1-abcdefghijklmnopqrstuvwxyz0123', LONG_ANT]
    let i = 0
    const lines: string[] = []
    const deps = makeDeps({ ask: async () => answers[i++], log: (l) => lines.push(l) })
    await maybeRunFirstRunSetup(deps)
    expect(deps.saved).toEqual([{ llmBackend: 'anthropic', apiKey: LONG_ANT }])
    expect(lines.join('\n')).toContain('looks like an OpenRouter key')
  })

  it('strips quotes and whitespace from a pasted key', async () => {
    const answers = ['2', `  "${LONG_ANT}"  `]
    let i = 0
    const deps = makeDeps({ ask: async () => answers[i++] })
    await maybeRunFirstRunSetup(deps)
    expect(deps.saved).toEqual([{ llmBackend: 'anthropic', apiKey: LONG_ANT }])
  })

  it('does not save a key the provider rejects, and gives up after three tries', async () => {
    const asked: string[] = []
    const deps = makeDeps({
      ask: async (q) => {
        asked.push(q)
        return q.startsWith('Type') ? '2' : LONG_ANT
      },
      testKey: async () => ({ status: 'invalid', message: 'nope' }),
    })
    const result = await maybeRunFirstRunSetup(deps)
    expect(deps.saved).toEqual([])
    expect(result).toEqual({})
    expect(asked.filter((q) => q.startsWith('Paste'))).toHaveLength(3)
  })

  it('still saves when the key could not be verified (offline)', async () => {
    const answers = ['2', LONG_ANT]
    let i = 0
    const deps = makeDeps({
      ask: async () => answers[i++],
      testKey: async () => ({ status: 'unverified', message: 'offline' }),
    })
    await maybeRunFirstRunSetup(deps)
    expect(deps.saved).toEqual([{ llmBackend: 'anthropic', apiKey: LONG_ANT }])
  })

  it('lists OpenRouter first and walks a new user through account, credits, key and spending limit', async () => {
    const answers = ['1', '']
    let i = 0
    const lines: string[] = []
    const deps = makeDeps({ ask: async () => answers[i++], log: (l) => lines.push(l) })
    await maybeRunFirstRunSetup(deps)
    const out = lines.join('\n')
    expect(out.indexOf('1) OpenRouter')).toBeGreaterThan(-1)
    expect(out).toContain('openrouter.ai/settings/credits')
    expect(out).toContain('Set a spending limit')
    expect(out).toContain('New Guardrail')
    expect(out).toContain('openrouter.ai/workspaces/default/guardrails')
  })

  it('tells people without Claude Code that installing it is an alternative', async () => {
    const lines: string[] = []
    await maybeRunFirstRunSetup(makeDeps({ log: (l) => lines.push(l) }))
    expect(lines.join('\n')).toMatch(/already use Claude Code/)
  })

  it('says Claude is already running when detected', async () => {
    const lines: string[] = []
    await maybeRunFirstRunSetup(makeDeps({ detectClaudeCli: async () => true, log: (l) => lines.push(l) }))
    expect(lines.join('\n')).toContain('Claude is already running on this computer')
  })
})
