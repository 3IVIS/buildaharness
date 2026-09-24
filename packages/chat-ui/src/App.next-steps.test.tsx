import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

/**
 * R7 — turn-end next-step options. After a full turn the reply carries `nextSteps`; the UI shows
 * them as chips under the newest reply only. Picking one fills the composer as an editable draft
 * (never sends), and the composer stays free for typing anything else.
 */
function fakeAssistant(nextSteps: { description: string; rationale: string; confidence: 'high' | 'medium' | 'low' }[]) {
  const transcript: { role: 'user' | 'assistant'; content: string }[] = []
  const turn = vi.fn(async (message: string) => {
    transcript.push({ role: 'user', content: message })
    const reply = `echo: ${message}`
    transcript.push({ role: 'assistant', content: reply })
    return { status: 'ok', reply, riskLevel: 'LOW', usage: { inputTokens: 1, outputTokens: 1 }, nextSteps: transcript.length === 2 ? nextSteps : undefined }
  })
  return {
    turn,
    assistant: {
      turn,
      getTranscript: vi.fn(async () => transcript),
      getPlanState: vi.fn(async () => null),
      clearSession: vi.fn(async () => {}),
      undoLastTurn: vi.fn(async () => ({ undone: false })),
      getMemorySummary: vi.fn(async () => ({ facts: [], reminders: [], pending: [], experience: { strategyWeights: {}, decompositions: [], recoverySequences: [] } })),
      searchTranscript: vi.fn(async () => []),
    },
  }
}

describe('App — turn-end next-step options', () => {
  beforeEach(() => {
    // Already-configured user: skips the first-launch SetupWizard (covered in its own tests below).
    localStorage.setItem('buildaharness.personal-assistant.config', JSON.stringify({ llmBackend: 'proxy' }))
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network in tests')))
  })
  afterEach(() => {
    localStorage.clear()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  async function setup(nextSteps: Parameters<typeof fakeAssistant>[0]) {
    vi.resetModules()
    const fake = fakeAssistant(nextSteps)
    vi.doMock('@buildaharness/aielia', async () => {
      const actual = await vi.importActual<typeof import('@buildaharness/aielia')>('@buildaharness/aielia')
      return { ...actual, PersonalAssistant: { create: vi.fn(async () => fake.assistant) } }
    })
    const { App } = await import('./App')
    const user = userEvent.setup()
    render(<App />)
    const input = screen.getByPlaceholderText('Message the assistant…') as HTMLTextAreaElement
    return { fake, user, input }
  }

  const steps = [
    { description: 'add tests for the login page', rationale: 'r', confidence: 'high' as const },
    { description: 'wire it into the router', rationale: 'r', confidence: 'medium' as const },
  ]

  it('shows the options under the reply; picking one fills the composer as a draft and does NOT send it', async () => {
    const { fake, user, input } = await setup(steps)
    await user.type(input, 'build a login page')
    await user.click(screen.getByRole('button', { name: 'Send' }))

    const chip = await screen.findByRole('button', { name: 'add tests for the login page' })
    await user.click(chip)

    expect(input.value).toBe('add tests for the login page')
    expect(fake.turn).toHaveBeenCalledTimes(1) // only the original message — the pick is a draft
  })

  it('the draft is editable, and typing your own message instead sends it normally', async () => {
    const { fake, user, input } = await setup(steps)
    await user.type(input, 'build a login page')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await user.click(await screen.findByRole('button', { name: 'wire it into the router' }))

    await user.clear(input)
    await user.type(input, 'actually, explain the router first')
    await user.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(fake.turn).toHaveBeenCalledTimes(2))
    expect(fake.turn).toHaveBeenLastCalledWith('actually, explain the router first', expect.anything())
  })

  it('the options belong to the newest reply only: they are gone once the next turn is answered without any', async () => {
    const { user, input } = await setup(steps)
    await user.type(input, 'build a login page')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByRole('button', { name: 'add tests for the login page' })

    await user.type(input, 'thanks')
    await user.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(screen.queryByRole('button', { name: 'add tests for the login page' })).not.toBeInTheDocument())
  })

  it('shows no options when the reply carries none', async () => {
    const { user, input } = await setup([])
    await user.type(input, 'hello there')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByText('echo: hello there')
    expect(screen.queryByRole('group', { name: 'Suggested next steps' })).not.toBeInTheDocument()
  })
})
