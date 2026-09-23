import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

/**
 * Phase 3 of plans/hierarchical_goal_tree_and_steering_plan.html (R1, mid-task steering) —
 * `goalGraphModeEnabled` in App.tsx is derived from `config.goalGraphMode`, resolved (as of Phase
 * 8) through the same `envOverridesFromImportMetaEnv`/`resolveConfig` chain as
 * oneLoopMode/askMode/planMode: `import.meta.env.VITE_ASSISTANT_GOAL_GRAPH` is read once into a
 * module-level `envOverrides` constant when App.tsx is first evaluated. Testing the "enabled"
 * branch therefore still needs the env var stubbed *before* App.tsx is first evaluated —
 * `vi.stubEnv` + `vi.resetModules()` + a fresh dynamic `import('./App')` per test, rather than
 * App.test.tsx's plain top-level `import { App } from './App'`.
 */

interface FakeTranscriptEntry {
  role: 'user' | 'assistant'
  content: string
}

/** A turn implementation that blocks on `gate` until the test calls `release()` — lets a test observe UI state while a turn is still in flight, mirroring cli.test.ts's DeferredReplyLLMClient. */
function createDeferredAssistant() {
  let transcript: FakeTranscriptEntry[] = []
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    release: () => release?.(),
    assistant: {
      turn: vi.fn(async (message: string) => {
        transcript.push({ role: 'user', content: message })
        await gate
        const reply = `echo: ${message}`
        transcript.push({ role: 'assistant', content: reply })
        return { status: 'ok', reply, riskLevel: 'LOW', usage: { inputTokens: 10, outputTokens: 5 } }
      }),
      getTranscript: vi.fn(async () => transcript),
      getPlanState: vi.fn(async () => null),
      clearSession: vi.fn(async () => {
        transcript = []
      }),
      undoLastTurn: vi.fn(async () => ({ undone: false })),
      getMemorySummary: vi.fn(async () => ({
        facts: [],
        reminders: [],
        pending: [],
        experience: { strategyWeights: {}, decompositions: [], recoverySequences: [] },
      })),
      searchTranscript: vi.fn(async () => []),
    },
  }
}

describe('App — mid-task steering composer (Phase 3, hierarchical_goal_tree_and_steering_plan.html)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network in tests')))
  })

  afterEach(() => {
    localStorage.clear()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('goalGraphMode enabled: composer and Send stay enabled while a turn is running, and a submitted message is accepted (not blocked) rather than dropped', async () => {
    vi.stubEnv('VITE_ASSISTANT_GOAL_GRAPH', 'enabled')
    vi.resetModules()

    const deferred = createDeferredAssistant()
    vi.doMock('@buildaharness/aielia', async () => {
      const actual = await vi.importActual<typeof import('@buildaharness/aielia')>('@buildaharness/aielia')
      return { ...actual, PersonalAssistant: { create: vi.fn(async () => deferred.assistant) } }
    })

    const { App } = await import('./App')
    const user = userEvent.setup()
    render(<App />)

    const input = screen.getByPlaceholderText('Message the assistant…')
    await user.type(input, 'first message')
    await user.click(screen.getByRole('button', { name: 'Send' }))

    // The turn is now in flight (blocked on deferred.gate) — busy is true. The composer clears
    // its own text on submit, so Send is correctly disabled right now for the ordinary
    // empty-input reason, not because of busy — typing again below is what actually proves busy
    // no longer disables it.
    await waitFor(() => expect(screen.getByText('first message')).toBeInTheDocument())
    expect(input).not.toBeDisabled()

    // Submitting a second message while busy must be accepted into the steering channel, not
    // silently dropped or blocked — it renders immediately as a user entry.
    await user.type(input, 'second message')
    expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(screen.getByText('second message')).toBeInTheDocument()
    // Only the first turn's echo exists so far — the second is queued, not yet run.
    expect(screen.queryByText('echo: second message')).not.toBeInTheDocument()

    deferred.release()
    // First turn's reply lands, then the queued second message is drained as a follow-up turn.
    await waitFor(() => expect(screen.getByText('echo: first message')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('echo: second message')).toBeInTheDocument())
  })

  it('goalGraphMode unset (default): composer and Send stay disabled while a turn is running, byte-identical to today (INV-43)', async () => {
    vi.resetModules()

    const deferred = createDeferredAssistant()
    vi.doMock('@buildaharness/aielia', async () => {
      const actual = await vi.importActual<typeof import('@buildaharness/aielia')>('@buildaharness/aielia')
      return { ...actual, PersonalAssistant: { create: vi.fn(async () => deferred.assistant) } }
    })

    const { App } = await import('./App')
    const user = userEvent.setup()
    render(<App />)

    const input = screen.getByPlaceholderText('Message the assistant…')
    await user.type(input, 'first message')
    await user.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(screen.getByText('first message')).toBeInTheDocument())
    expect(input).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()

    deferred.release()
    await waitFor(() => expect(screen.getByText('echo: first message')).toBeInTheDocument())
  })
})
