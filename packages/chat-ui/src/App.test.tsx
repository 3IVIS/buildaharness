import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LLMClient, AnthropicLLMClient, OpenAICompatibleLLMClient } from '@buildaharness/runtime'
import { PersonalAssistant } from '@buildaharness/personal-assistant'
import { App } from './App'

vi.mock('@buildaharness/runtime', async () => {
  const actual = await vi.importActual<typeof import('@buildaharness/runtime')>('@buildaharness/runtime')
  return { ...actual, LLMClient: vi.fn() }
})

/** A transcript entry shape close enough to ChatMessage for these tests' purposes. */
interface FakeTranscriptEntry {
  role: 'user' | 'assistant'
  content: string
}

vi.mock('@buildaharness/personal-assistant', async () => {
  const actual = await vi.importActual<typeof import('@buildaharness/personal-assistant')>('@buildaharness/personal-assistant')
  return {
    ...actual,
    PersonalAssistant: {
      create: vi.fn(async () => {
        let transcript: FakeTranscriptEntry[] = []
        return {
          turn: vi.fn(async (message: string, options?: { approved?: boolean; pendingActionId?: string }) => {
            // Mirrors a real staged write_file/run_shell_command/batch-research pause
            // (assistant.ts's pendingActionId gate, not the message-level risk gate below):
            // only resolves — either applying or discarding — once the caller resumes with the
            // exact pendingActionId this stage handed back, exactly like resolvePendingAction
            // requires. A caller that resends the bare message (as chat-ui's approval UI used to,
            // pre-T8) gets staged again instead of ever resolving — this is what makes the T8
            // regression tests below fail against the pre-fix code and pass against the fix.
            if (message.includes('staged action')) {
              if (options?.pendingActionId === 'pending-staged-1') {
                transcript.push({ role: 'user', content: message })
                const reply = options.approved ? 'Wrote "file.txt".' : 'Cancelled — nothing was written or run.'
                transcript.push({ role: 'assistant', content: reply })
                return { status: 'ok', reply }
              }
              transcript.push({ role: 'user', content: message })
              return {
                status: 'needs_approval',
                reply: null,
                reason: 'Proposes writing to "file.txt"',
                riskLevel: 'HIGH',
                pendingActionId: 'pending-staged-1',
                pendingActionKind: 'batch',
              }
            }
            if (message.includes('approval') && !options?.approved) {
              transcript.push({ role: 'user', content: message })
              return { status: 'needs_approval', reply: null, reason: 'looks risky', riskLevel: 'HIGH' }
            }
            transcript.push({ role: 'user', content: message })
            const reply = `echo: ${message}`
            transcript.push({ role: 'assistant', content: reply })
            return { status: 'ok', reply, riskLevel: 'LOW', usage: { inputTokens: 10, outputTokens: 5 } }
          }),
          getTranscript: vi.fn(async () => transcript),
          clearSession: vi.fn(async () => { transcript = [] }),
          undoLastTurn: vi.fn(async () => {
            if (transcript.length === 0) return { undone: false }
            const dropCount = transcript[transcript.length - 1].role === 'assistant' ? 2 : 1
            transcript = transcript.slice(0, transcript.length - dropCount)
            return { undone: true }
          }),
          getMemorySummary: vi.fn(async () => ({
            facts: [],
            reminders: [],
            experience: { strategyWeights: {}, decompositions: [], recoverySequences: [] },
          })),
          searchTranscript: vi.fn(async (query: string) =>
            query === 'nomatch'
              ? []
              : [{ sessionId: 'session-aaaaaaaa-1111', role: 'user' as const, content: `a past message about ${query}`, at: '2026-07-01T10:00:00.000Z', score: 1 }],
          ),
        }
      }),
    },
  }
})

describe('App', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    // Opening Settings now runs a health check (checkProxyReachable) that hits a real
    // network URL — stub fetch so tests never depend on (or wait on) an actual network call.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network in tests')))
  })

  afterEach(() => {
    localStorage.clear()
    vi.unstubAllGlobals()
  })

  it('sends a message and renders the assistant reply', async () => {
    const user = userEvent.setup()
    render(<App />)

    const input = screen.getByPlaceholderText('Message the assistant…')
    await user.type(input, 'hello there')
    await user.click(screen.getByRole('button', { name: 'Send' }))

    expect(screen.getByText('hello there')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('echo: hello there')).toBeInTheDocument())
  })

  it('pressing Enter submits the message', async () => {
    const user = userEvent.setup()
    render(<App />)

    const input = screen.getByPlaceholderText('Message the assistant…')
    await user.type(input, 'hello there{Enter}')

    expect(screen.getByText('hello there')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('echo: hello there')).toBeInTheDocument())
    expect(input).toHaveValue('')
  })

  it('pressing Shift+Enter inserts a newline instead of submitting', async () => {
    const user = userEvent.setup()
    render(<App />)

    const input = screen.getByPlaceholderText('Message the assistant…')
    await user.type(input, 'line one{Shift>}{Enter}{/Shift}line two')

    // Not sent yet — Shift+Enter must not trigger a submit.
    expect(screen.queryByText('echo: line one')).not.toBeInTheDocument()
    expect(input).toHaveValue('line one\nline two')

    await user.click(screen.getByRole('button', { name: 'Send' }))
    // The bubble renders content as markdown (ChatMessageBubble), which collapses a single
    // soft line break to a space — assert on the rendered text, not the raw '\n'-joined value
    // already verified above.
    await waitFor(() => expect(screen.getByText('echo: line one line two')).toBeInTheDocument())
  })

  it('renders an approval card for needs_approval and resolves it on approve', async () => {
    const user = userEvent.setup()
    render(<App />)

    const input = screen.getByPlaceholderText('Message the assistant…')
    await user.type(input, 'needs approval please')
    await user.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(screen.getByText('looks risky')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Approve' }))

    await waitFor(() => expect(screen.getByText('Approved.')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('echo: needs approval please')).toBeInTheDocument())
  })

  describe('approval flow — pendingActionId threading for staged actions (T8)', () => {
    it('Approve on a staged write/shell/batch action resumes with pendingActionId and actually applies it', async () => {
      const user = userEvent.setup()
      render(<App />)

      await user.type(screen.getByPlaceholderText('Message the assistant…'), 'run this staged action')
      await user.click(screen.getByRole('button', { name: 'Send' }))

      // pendingActionKind: 'batch' on this pause — the card must label it accordingly, not
      // fall back to the generic riskLevel label (see ApprovalCard's kindLabel precedence).
      await waitFor(() => expect(screen.getByText('Needs approval — batch research')).toBeInTheDocument())
      await user.click(screen.getByRole('button', { name: 'Approve' }))

      // Without threading pendingActionId back into turn(), the mock (mirroring the real
      // resolvePendingAction gate) re-stages instead of resolving — this would still show
      // "Needs approval — batch research", never "Wrote...". This assertion is what the pre-fix
      // code fails.
      await waitFor(() => expect(screen.getByText('Wrote "file.txt".')).toBeInTheDocument())
    })

    it('Deny on a staged action resumes with pendingActionId to actually discard it, not just flip local UI state', async () => {
      const user = userEvent.setup()
      render(<App />)

      await user.type(screen.getByPlaceholderText('Message the assistant…'), 'run this staged action')
      await user.click(screen.getByRole('button', { name: 'Send' }))

      await waitFor(() => expect(screen.getByText('Needs approval — batch research')).toBeInTheDocument())
      await user.click(screen.getByRole('button', { name: 'Deny' }))

      await waitFor(() => expect(screen.getByText('Denied.')).toBeInTheDocument())
      // The pre-fix handleDeny never called turn() at all for this gate, so the staged action was
      // simply abandoned — no "Cancelled..." reply was ever produced. Getting this message back
      // proves a real turn({approved: false, pendingActionId}) round trip happened.
      await waitFor(() => expect(screen.getByText('Cancelled — nothing was written or run.')).toBeInTheDocument())
    })
  })

  it('opens Settings via the gear icon, saves a change, and returns to the chat view', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.getByText('Settings')).toBeInTheDocument()

    const proxyInput = screen.getByDisplayValue('http://localhost:8787')
    await user.clear(proxyInput)
    await user.type(proxyInput, 'http://saved-proxy:9')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(screen.getByPlaceholderText('Message the assistant…')).toBeInTheDocument())
    expect(JSON.parse(localStorage.getItem('buildaharness.personal-assistant.config') ?? '{}')).toMatchObject({
      proxyUrl: 'http://saved-proxy:9',
    })
  })

  it('Cancel from Settings returns to chat without persisting anything', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.getByPlaceholderText('Message the assistant…')).toBeInTheDocument()
    expect(localStorage.getItem('buildaharness.personal-assistant.config')).toBeNull()
  })

  it('"New chat" clears the conversation from the screen', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.type(screen.getByPlaceholderText('Message the assistant…'), 'hello there')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(screen.getByText('echo: hello there')).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'New chat' }))

    await waitFor(() => expect(screen.queryByText('hello there')).not.toBeInTheDocument())
    expect(screen.queryByText('echo: hello there')).not.toBeInTheDocument()
  })

  it('"Export" downloads the transcript as a markdown file', async () => {
    const user = userEvent.setup()
    URL.createObjectURL = vi.fn(() => 'blob:mock-url')
    URL.revokeObjectURL = vi.fn()
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<App />)

    await user.type(screen.getByPlaceholderText('Message the assistant…'), 'hello there')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(screen.getByText('echo: hello there')).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'Export transcript' }))

    await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1))
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url')
  })

  it('"Export" is disabled with no conversation yet', async () => {
    render(<App />)
    expect(await screen.findByRole('button', { name: 'Export transcript' })).toBeDisabled()
  })

  it('"Undo" removes the last exchange from the screen', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.type(screen.getByPlaceholderText('Message the assistant…'), 'first message')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(screen.getByText('echo: first message')).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'Undo last exchange' }))

    await waitFor(() => expect(screen.queryByText('first message')).not.toBeInTheDocument())
    expect(screen.queryByText('echo: first message')).not.toBeInTheDocument()
  })

  it('"Undo" is disabled with no conversation yet', async () => {
    render(<App />)
    expect(await screen.findByRole('button', { name: 'Undo last exchange' })).toBeDisabled()
  })

  it('Settings shows Diagnostics data once loaded (memory, usage, health)', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.type(screen.getByPlaceholderText('Message the assistant…'), 'hello there')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(screen.getByText('echo: hello there')).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'Settings' }))

    await waitFor(() => expect(screen.getByText(/10 in \/ 5 out tokens/)).toBeInTheDocument())
    expect(screen.getByText(/2 messages this session/)).toBeInTheDocument()
    expect(screen.getByText(/proxy reachable/)).toBeInTheDocument()
  })

  describe('createLlmClient backend selection (plain browser — isTauri() is false in jsdom)', () => {
    function seedConfig(patch: Record<string, unknown>): void {
      localStorage.setItem('buildaharness.personal-assistant.config', JSON.stringify(patch))
    }

    function lastLlmClient(): unknown {
      const calls = (PersonalAssistant.create as unknown as { mock: { calls: Array<[{ llmClient: unknown }]> } }).mock.calls
      return calls.at(-1)?.[0]?.llmClient
    }

    it('llmBackend "proxy" (default) constructs LLMClient', async () => {
      render(<App />)
      await waitFor(() => expect(PersonalAssistant.create).toHaveBeenCalled())
      expect(lastLlmClient()).toBeInstanceOf(LLMClient)
    })

    it('llmBackend "anthropic" constructs AnthropicLLMClient', async () => {
      seedConfig({ llmBackend: 'anthropic', apiKey: 'sk-ant-test' })
      render(<App />)
      await waitFor(() => expect(PersonalAssistant.create).toHaveBeenCalled())
      expect(lastLlmClient()).toBeInstanceOf(AnthropicLLMClient)
    })

    it('llmBackend "openai" constructs OpenAICompatibleLLMClient', async () => {
      seedConfig({ llmBackend: 'openai', apiKey: 'sk-openai-test' })
      render(<App />)
      await waitFor(() => expect(PersonalAssistant.create).toHaveBeenCalled())
      expect(lastLlmClient()).toBeInstanceOf(OpenAICompatibleLLMClient)
    })

    it('llmBackend "openrouter" constructs OpenAICompatibleLLMClient', async () => {
      seedConfig({ llmBackend: 'openrouter', apiKey: 'sk-or-test' })
      render(<App />)
      await waitFor(() => expect(PersonalAssistant.create).toHaveBeenCalled())
      expect(lastLlmClient()).toBeInstanceOf(OpenAICompatibleLLMClient)
    })

    it('llmBackend "claude-cli" degrades to LLMClient (proxy) with a console warning — a plain browser tab can\'t run `claude -p`', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      seedConfig({ llmBackend: 'claude-cli' })
      render(<App />)
      await waitFor(() => expect(PersonalAssistant.create).toHaveBeenCalled())
      expect(lastLlmClient()).toBeInstanceOf(LLMClient)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('claude-cli'))
    })
  })

  describe('webTools wiring (T3 — createWebTools is real, not a stub)', () => {
    function seedConfig(patch: Record<string, unknown>): void {
      localStorage.setItem('buildaharness.personal-assistant.config', JSON.stringify(patch))
    }

    function lastWebTools(): { search: (query: string) => Promise<unknown> } | undefined {
      const calls = (PersonalAssistant.create as unknown as { mock: { calls: Array<[{ webTools?: { search: (query: string) => Promise<unknown> } }]> } }).mock.calls
      return calls.at(-1)?.[0]?.webTools
    }

    it('enableWeb unset (default) passes no webTools at all', async () => {
      render(<App />)
      await waitFor(() => expect(PersonalAssistant.create).toHaveBeenCalled())
      expect(lastWebTools()).toBeUndefined()
    })

    it('enableWeb true passes a webTools.search that really calls DuckDuckGo\'s endpoint via fetch (not a no-op stub)', async () => {
      seedConfig({ enableWeb: true })
      render(<App />)
      await waitFor(() => expect(PersonalAssistant.create).toHaveBeenCalled())
      const webTools = lastWebTools()
      expect(webTools?.search).toBeInstanceOf(Function)

      // fetch is stubbed (beforeEach) to reject — this proves search() genuinely reaches the
      // network layer instead of being a silently-inert stub, and that a failure (e.g. the real
      // CORS block a plain browser tab hits against html.duckduckgo.com, per App.tsx's doc
      // comment) propagates as a rejection for assistant.ts's tool dispatch to catch, not swallow.
      await expect(webTools!.search('test query')).rejects.toThrow()
      expect(fetch).toHaveBeenCalledWith('https://html.duckduckgo.com/html/', expect.anything())
    })

    it('enableWeb true + searchBackend "brave" passes a webTools.search that calls Brave\'s API instead', async () => {
      seedConfig({ enableWeb: true, searchBackend: 'brave', braveApiKey: 'test-key' })
      render(<App />)
      await waitFor(() => expect(PersonalAssistant.create).toHaveBeenCalled())
      const webTools = lastWebTools()
      await expect(webTools!.search('test query')).rejects.toThrow()
      expect(fetch).toHaveBeenCalledWith(expect.stringContaining('api.search.brave.com'), expect.anything())
    })
  })

  describe('/search UI (T6)', () => {
    it('opens the Search panel via the header button and renders results for a query with matches', async () => {
      const user = userEvent.setup()
      render(<App />)

      await user.click(screen.getByRole('button', { name: 'Search' }))
      expect(screen.getByText('Search', { selector: '.search-panel__title' })).toBeInTheDocument()

      await user.type(screen.getByLabelText('Search past messages'), 'garden')
      await user.click(screen.getByRole('button', { name: 'Search' }))

      // Highlighting splits the snippet across <mark>/<span> nodes — match on the result row's
      // accessible name (aggregated text), not a single text node.
      await waitFor(() => expect(screen.getByRole('button', { name: /a past message about garden/ })).toBeInTheDocument())
    })

    it('shows a clear empty state for a query with no matches', async () => {
      const user = userEvent.setup()
      render(<App />)

      await user.click(screen.getByRole('button', { name: 'Search' }))
      await user.type(screen.getByLabelText('Search past messages'), 'nomatch')
      await user.click(screen.getByRole('button', { name: 'Search' }))

      await waitFor(() => expect(screen.getByText('No results for "nomatch".')).toBeInTheDocument())
    })

    it('"← Back" returns to the chat view', async () => {
      const user = userEvent.setup()
      render(<App />)

      await user.click(screen.getByRole('button', { name: 'Search' }))
      await user.click(screen.getByRole('button', { name: '← Back' }))

      expect(screen.getByPlaceholderText('Message the assistant…')).toBeInTheDocument()
    })
  })
})
