import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createScriptedLLMClient } from '@buildaharness/personal-assistant'
import { App } from './App'
import { setAssistantTestHooks } from './assistant-test-hooks'
import { createInMemoryFsBackend } from './e2e/in-memory-fs-backend'

/**
 * The "extended jsdom test" from plans/chat_ui_browser_e2e_plan.html's rejected-alternatives
 * list, now earned as phase B1's own coverage: NO module-wide `vi.mock` of
 * `@buildaharness/personal-assistant` — a real `PersonalAssistant` runs against a scripted
 * `ILLMClient` injected through the B1 seam, mounted in `<App/>`, on a real `turn()`.
 *
 * Asserts (a) flag OFF → proposerKind 'posthoc', (b) a persisted `oneLoopMode: 'enabled'` →
 * 'flat-oneloop', (c) identical reply text both ways.
 */

const STORAGE_KEY = 'buildaharness.personal-assistant.config'
const SEED = { '/workspace/note.txt': 'the note says hi' }
const SCRIPT = () => ({
  responses: [
    { content: '', toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'note.txt' } }] },
    'The note says hi.',
  ],
  // The flat tool loop streams its final answer via callChat once no more tool calls come — keep
  // that text the same as the structured final response so either path yields an identical reply.
  streamChunks: ['The note says hi.'],
})

function installSeam(): void {
  setAssistantTestHooks({
    makeLlmClient: () => createScriptedLLMClient(SCRIPT()),
    makeFsBackend: () => createInMemoryFsBackend(SEED),
  })
}

async function sendAndReadReply(message: string): Promise<{ kind: string; reply: string }> {
  const user = userEvent.setup()
  const { container } = render(<App />)
  const input = await screen.findByPlaceholderText('Message the assistant…')

  // The assistant is built in an async mount effect; a send before it resolves lands a
  // retryable "still starting up" error entry. Send, then retry via that button if it appears.
  await user.type(input, message)
  await user.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(
    async () => {
      const retry = screen.queryByRole('button', { name: /retry/i })
      if (retry) await user.click(retry)
      expect(screen.getByTestId('proposer-kind')).toBeInTheDocument()
    },
    { timeout: 10000 },
  )

  const bubbles = container.querySelectorAll('.bubble__content--markdown')
  return {
    kind: screen.getByTestId('proposer-kind').textContent ?? '',
    reply: bubbles.length > 0 ? (bubbles[bubbles.length - 1].textContent ?? '').trim() : '',
  }
}

describe('App — B1 LLM injection seam', () => {
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

  it('flag OFF → proposerKind "posthoc"', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ llmBackend: 'proxy' }))
    installSeam()
    const { kind, reply } = await sendAndReadReply('read note.txt for me')
    expect(kind).toBe('posthoc')
    expect(reply.length).toBeGreaterThan(0)
  })

  it('persisted oneLoopMode "enabled" → proposerKind "flat-oneloop", identical reply text', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ llmBackend: 'proxy' }))
    installSeam()
    const off = await sendAndReadReply('read note.txt for me')

    cleanup()
    setAssistantTestHooks(null)
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ llmBackend: 'proxy', oneLoopMode: 'enabled' }))
    installSeam()
    const on = await sendAndReadReply('read note.txt for me')

    expect(off.kind).toBe('posthoc')
    expect(on.kind).toBe('flat-oneloop')
    // Parity: the flag changes which path ran, not the user-visible reply (INV-19).
    expect(on.reply).toBe(off.reply)
  })
})
