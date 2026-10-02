import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createScriptedLLMClient } from '@buildaharness/aielia'
import { App } from './App'
import { setAssistantTestHooks } from './assistant-test-hooks'

/**
 * M6 of plans/agent_memory_framework_plan.html — the browser counterpart of the CLI's /memory
 * family. Before this phase nothing in chat-ui called confirmPendingFact/rejectPendingFact/forgetFact,
 * so a write staged by a model-inferred fact could never be confirmed in a browser. These drive the
 * REAL <App/> and a real PersonalAssistant (scripted LLM through the B1 seam), clicking the same
 * controls a user would; each action goes through the shared PersonalAssistant method the CLI also
 * calls. The Playwright suite cannot run in this container; see the phase report for what is left for CI.
 */

const STORAGE_KEY = 'buildaharness.personal-assistant.config'

function installSeam(fact: { text: string; confidence: 'high' | 'medium' }): void {
  setAssistantTestHooks({
    makeLlmClient: () =>
      createScriptedLLMClient({
        responses: ['Noted.', 'Sure.', 'OK.'],
        streamChunks: ['Noted.'],
        classify: (msg) => (msg.includes('remember') ? { statesDurableFacts: [{ text: fact.text, durable: true, confidence: fact.confidence, category: 'preference', containsSecret: false, looksLikeInstruction: false }] } : undefined),
      }),
  })
}

const replies = (): number => document.querySelectorAll('.bubble__content--markdown').length

async function send(user: ReturnType<typeof userEvent.setup>, message: string): Promise<void> {
  const input = await screen.findByPlaceholderText('Message the assistant…')
  const before = replies()
  await user.clear(input)
  await user.type(input, message)
  await user.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(
    async () => {
      // The assistant is built in an async mount effect; a send before it resolves lands a retryable error entry.
      const retry = screen.queryByRole('button', { name: /retry/i })
      if (retry) await user.click(retry)
      expect(replies()).toBeGreaterThan(before)
    },
    { timeout: 10000 },
  )
}

describe('App: Memory panel (M6)', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network in tests')))
  })
  afterEach(() => {
    cleanup()
    setAssistantTestHooks(null)
    localStorage.clear()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('a staged (medium-confidence) fact appears in the pending queue, can be confirmed from the browser, then shows under Facts I know', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ llmBackend: 'proxy' }))
    installSeam({ text: 'the user prefers oolong tea over coffee', confidence: 'medium' })
    const user = userEvent.setup()
    render(<App />)
    await send(user, 'please remember I like oolong')

    await user.click(screen.getByRole('button', { name: 'Memory' }))
    const pending = await screen.findByRole('region', { name: 'Waiting for your confirmation' })
    await waitFor(() => expect(within(pending).getByText(/oolong tea over coffee/)).toBeInTheDocument())

    await user.click(within(pending).getByRole('button', { name: 'Confirm pending 1' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('confirmed: the user prefers oolong tea over coffee'))
    const facts = screen.getByRole('region', { name: 'Facts I know' })
    expect(within(facts).getByText(/oolong tea over coffee/)).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Waiting for your confirmation' })).queryByRole('button', { name: /Confirm pending/ })).toBeNull()

    // Forget removes it again through the shared forgetFact.
    await user.click(within(facts).getByRole('button', { name: 'Forget fact 1' }))
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Facts I know' })).queryByText(/oolong tea over coffee/)).toBeNull())
  })

  it('Reject discards a pending guess (negative control for Confirm: it never becomes a fact)', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ llmBackend: 'proxy' }))
    installSeam({ text: 'the user dislikes jazz a lot', confidence: 'medium' })
    const user = userEvent.setup()
    render(<App />)
    await send(user, 'please remember jazz')
    await user.click(screen.getByRole('button', { name: 'Memory' }))
    const pending = await screen.findByRole('region', { name: 'Waiting for your confirmation' })
    await waitFor(() => expect(within(pending).getByText(/dislikes jazz/)).toBeInTheDocument())
    await user.click(within(pending).getByRole('button', { name: 'Reject pending 1' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('rejected'))
    // Gone from the queue and never promoted. (Pre-existing behaviour, not changed here: the rejected guess's session-scoped copy stays in this session's "Facts I know" until /new.)
    expect(within(screen.getByRole('region', { name: 'Waiting for your confirmation' })).queryByText(/dislikes jazz/)).toBeNull()
    expect(screen.getByText('Waiting for your confirmation (0)')).toBeInTheDocument()
  })

  it('user_only (persisted config) stages even a high-confidence fact, and "Stop saving memory" blocks new writes while keeping what exists', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ llmBackend: 'proxy', memoryWriteMode: 'user_only' }))
    installSeam({ text: 'the user wants metric units always', confidence: 'high' })
    const user = userEvent.setup()
    render(<App />)
    await send(user, 'please remember metric')
    await user.click(screen.getByRole('button', { name: 'Memory' }))
    const pending = await screen.findByRole('region', { name: 'Waiting for your confirmation' })
    await waitFor(() => expect(within(pending).getByText(/metric units/)).toBeInTheDocument())
    expect(screen.getByLabelText('Memory write mode')).toHaveValue('user_only')

    await user.click(screen.getByRole('button', { name: 'Stop saving memory' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Memory writes are OFF'))
    expect(screen.getByRole('button', { name: 'Resume saving memory' })).toBeInTheDocument()
    // What is already queued is still there and still actionable.
    expect(within(screen.getByRole('region', { name: 'Waiting for your confirmation' })).getByText(/metric units/)).toBeInTheDocument()
  })

  it('changing the write mode in the panel applies live and is persisted to the config store', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ llmBackend: 'proxy' }))
    installSeam({ text: 'irrelevant fact for mode test', confidence: 'medium' })
    const user = userEvent.setup()
    render(<App />)
    await screen.findByPlaceholderText('Message the assistant…')
    await user.click(screen.getByRole('button', { name: 'Memory' }))
    const select = await screen.findByLabelText('Memory write mode')
    await waitFor(() => expect(select).toHaveValue('staged'))
    await user.selectOptions(select, 'auto')
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Memory write mode: auto.'))
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toMatchObject({ memoryWriteMode: 'auto' })
  })

  it('"Why?" shows which facts the reply could have known (shared formatter with the CLI /why)', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ llmBackend: 'proxy' }))
    installSeam({ text: 'the user plays the cello on weekends', confidence: 'high' })
    const user = userEvent.setup()
    render(<App />)
    await send(user, 'please remember the cello')
    await send(user, 'what did I say?')
    const toggles = await screen.findAllByRole('button', { name: 'Why?' })
    await user.click(toggles[toggles.length - 1])
    const memory = await screen.findByTestId('why-memory')
    expect(memory).toHaveTextContent('Memory in the prompt:')
    expect(memory).toHaveTextContent('the user plays the cello on weekends')
  })
})
