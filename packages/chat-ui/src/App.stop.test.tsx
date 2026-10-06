import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

/** Phase 5 — a running turn can be stopped, shows elapsed time, and leaves Settings reachable. */
function fakeAssistant() {
  const turn = vi.fn((_message: string, options?: { signal?: AbortSignal }) => new Promise((resolve) => {
    options?.signal?.addEventListener('abort', () => resolve({ status: 'cancelled', reply: null, reason: 'Stopped by user' }))
  }))
  return {
    turn,
    assistant: {
      turn,
      getTranscript: vi.fn(async () => []),
      getPlanState: vi.fn(async () => null),
      clearSession: vi.fn(async () => {}),
      undoLastTurn: vi.fn(async () => ({ undone: false })),
      getMemorySummary: vi.fn(async () => ({ facts: [], reminders: [], pending: [], experience: { strategyWeights: {}, decompositions: [], recoverySequences: [] } })),
      getLastMemoryInjection: vi.fn(() => undefined),
      getMemoryStatus: vi.fn(async () => ({ mode: 'staged', off: false, budgetedRender: false, budgetChars: 4000, storeChars: 0, liveFacts: 0, pending: 0, flaggedPending: 0, retired: 0, auditEnabled: false, auditEntries: 0 })),
      searchTranscript: vi.fn(async () => []),
    },
  }
}

describe('App — stopping a running turn', () => {
  beforeEach(() => {
    localStorage.setItem('buildaharness.personal-assistant.config', JSON.stringify({ llmBackend: 'proxy' }))
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network in tests')))
  })
  afterEach(() => {
    localStorage.clear()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  async function setup(config: Record<string, unknown> = { llmBackend: 'proxy' }) {
    localStorage.setItem('buildaharness.personal-assistant.config', JSON.stringify(config))
    vi.resetModules()
    const fake = fakeAssistant()
    vi.doMock('@buildaharness/aielia', async () => {
      const actual = await vi.importActual<typeof import('@buildaharness/aielia')>('@buildaharness/aielia')
      return { ...actual, PersonalAssistant: { create: vi.fn(async () => fake.assistant) } }
    })
    const { App } = await import('./App')
    const user = userEvent.setup()
    render(<App />)
    const input = screen.getByPlaceholderText('Message Aielia…') as HTMLTextAreaElement
    return { fake, user, input }
  }

  it('shows a Stop button while busy, shows elapsed time, and Stop ends the turn with a "Stopped" line', async () => {
    const { fake, user, input } = await setup()
    await user.type(input, 'do something slow')
    await user.click(screen.getByRole('button', { name: 'Send' }))

    const stop = await screen.findByRole('button', { name: 'Stop' })
    expect(screen.getByText(/0:0\d$/)).toBeInTheDocument()

    await user.click(stop)
    expect(await screen.findByRole('status')).toHaveTextContent('Stopped')
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    expect(fake.turn.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  })

  it('Settings can be opened mid-turn and Back returns to the running chat', async () => {
    const { user, input } = await setup()
    await user.type(input, 'do something slow')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByRole('button', { name: 'Stop' })

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.getByText(/still replying/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '← Back' }))
    expect(await screen.findByRole('button', { name: 'Stop' })).toBeInTheDocument()
  })

  it('shows an "Approvals off" chip that opens Settings only when skip-permissions is on', async () => {
    const { user } = await setup({ llmBackend: 'proxy', dangerouslySkipPermissions: true })
    const chip = await screen.findByRole('button', { name: 'Approvals off' })
    await user.click(chip)
    expect(await screen.findByRole('button', { name: '← Back' })).toBeInTheDocument()
  })

  it('shows no "Approvals off" chip by default', async () => {
    await setup()
    await screen.findByPlaceholderText('Message Aielia…')
    expect(screen.queryByRole('button', { name: 'Approvals off' })).toBeNull()
  })
})
