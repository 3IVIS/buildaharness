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
          turn: vi.fn(async (message: string, options?: { approved?: boolean }) => {
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
})
