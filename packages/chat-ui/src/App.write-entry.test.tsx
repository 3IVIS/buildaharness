import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

/** The Chat/Write drop-down: shown on the desktop, and on a hosted page whose build names the Write page; a plain browser tab has nowhere to go and must not show it. */

function fakeAssistant() {
  return {
    turn: vi.fn(async () => ({ status: 'ok', reply: 'ok', riskLevel: 'LOW', usage: { inputTokens: 1, outputTokens: 1 } })),
    getTranscript: vi.fn(async () => []),
    getPlanState: vi.fn(async () => null),
    getPlanGraph: vi.fn(async () => null),
    clearSession: vi.fn(async () => {}),
    undoLastTurn: vi.fn(async () => ({ undone: false })),
    getSpendState: vi.fn(async () => ({ cumulativeCostUsd: 0, cumulativeCalls: 0, cumulativeInputTokens: 0, cumulativeOutputTokens: 0 })),
    getMemorySummary: vi.fn(async () => ({ facts: [], reminders: [], pending: [], experience: { strategyWeights: {}, decompositions: [], recoverySequences: [] } })),
    getLastMemoryInjection: vi.fn(() => undefined),
    searchTranscript: vi.fn(async () => []),
  }
}

describe('App: the Write entry', () => {
  beforeEach(() => {
    localStorage.setItem('buildaharness.personal-assistant.config', JSON.stringify({ llmBackend: 'proxy' }))
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network in tests')))
    vi.resetModules()
  })
  afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetModules() })

  it('is not in the header of a plain browser tab', async () => {
    vi.doMock('@buildaharness/aielia', async () => {
      const actual = await vi.importActual<typeof import('@buildaharness/aielia')>('@buildaharness/aielia')
      return { ...actual, PersonalAssistant: { create: vi.fn(async () => fakeAssistant()) } }
    })
    const { App } = await import('./App')
    render(<App />)
    await screen.findByPlaceholderText('Message Aielia…')
    expect(screen.queryByRole('button', { name: 'Memory' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Write' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Chat/ })).toBeNull()
  })

  it('is a Chat/Write drop-down in the title of a hosted page whose build names the Write page', async () => {
    vi.stubEnv('VITE_APP_URL_WRITE', '/write/')
    vi.doMock('@buildaharness/aielia', async () => {
      const actual = await vi.importActual<typeof import('@buildaharness/aielia')>('@buildaharness/aielia')
      return { ...actual, PersonalAssistant: { create: vi.fn(async () => fakeAssistant()) } }
    })
    const { App } = await import('./App')
    render(<App />)
    await screen.findByPlaceholderText('Message Aielia…')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /^Chat/ }))
    expect(screen.getByRole('menuitemradio', { name: /Aielia Chat/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('menuitemradio', { name: /Aielia Write/ })).toBeInTheDocument()
  })
})
