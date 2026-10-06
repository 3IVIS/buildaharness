import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

/**
 * The turn notices. The CLI prints `AssistantTurnResult.reviewNotice` (the semantic change reviewer's
 * advisory) and `contradictionNotice` under the reply, so the browser surface must show it too — the same mechanism on both surfaces.
 */
function fakeAssistant(notices: { reviewNotice?: string; contradictionNotice?: string }) {
  const transcript: { role: 'user' | 'assistant'; content: string }[] = []
  return {
    turn: vi.fn(async (message: string) => {
      transcript.push({ role: 'user', content: message })
      transcript.push({ role: 'assistant', content: 'a catering plan' })
      return { status: 'ok', reply: 'a catering plan', riskLevel: 'LOW', usage: { inputTokens: 1, outputTokens: 1 }, ...notices }
    }),
    getTranscript: vi.fn(async () => transcript),
    getPlanState: vi.fn(async () => null),
    clearSession: vi.fn(async () => {}),
    undoLastTurn: vi.fn(async () => ({ undone: false })),
    getMemorySummary: vi.fn(async () => ({ facts: [], reminders: [], pending: [], experience: { strategyWeights: {}, decompositions: [], recoverySequences: [] } })),
    getLastMemoryInjection: vi.fn(() => undefined),
          getMemoryStatus: vi.fn(async () => ({ mode: 'staged', off: false, budgetedRender: false, budgetChars: 4000, storeChars: 0, liveFacts: 0, pending: 0, flaggedPending: 0, retired: 0, auditEnabled: false, auditEntries: 0 })),
          searchTranscript: vi.fn(async () => []),
  }
}

describe('App — turn notices (change review, contradiction)', () => {
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

  async function send(notices: { reviewNotice?: string; contradictionNotice?: string }) {
    vi.resetModules()
    const assistant = fakeAssistant(notices)
    vi.doMock('@buildaharness/aielia', async () => {
      const actual = await vi.importActual<typeof import('@buildaharness/aielia')>('@buildaharness/aielia')
      return { ...actual, PersonalAssistant: { create: vi.fn(async () => assistant) } }
    })
    const { App } = await import('./App')
    const user = userEvent.setup()
    render(<App />)
    await user.type(screen.getByPlaceholderText('Message Aielia…'), 'plan the offsite catering')
    await user.click(screen.getByRole('button', { name: 'Send' }))
  }

  it('shows the notice under the reply', async () => {
    await send({ reviewNotice: 'Heads up — this may conflict with something you told me earlier: three years exceeds the twelve-month cap' })
    expect(await screen.findByRole('note')).toHaveTextContent('three years exceeds the twelve-month cap')
    expect(screen.getByText('a catering plan')).toBeInTheDocument()
  })

  it('shows nothing extra when the turn has no notice', async () => {
    await send({})
    await screen.findByText('a catering plan')
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('shows the contradiction notice under the reply too — the CLI prints it, so the browser must', async () => {
    await send({ contradictionNotice: 'Heads up — this seems to conflict with something you told me earlier.' })
    expect(await screen.findByRole('note')).toHaveTextContent('conflict with something you told me earlier')
  })
})
