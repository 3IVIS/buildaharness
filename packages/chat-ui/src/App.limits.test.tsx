import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createScriptedLLMClient } from '@buildaharness/aielia'
import { App } from './App'
import { setAssistantTestHooks } from './assistant-test-hooks'

/**
 * U4b of plans/surface_unification_plan.html: the apps honour the spend cap and /project like the CLI.
 * Drives the real <App/> and a real PersonalAssistant through the scripted-LLM seam.
 */

const STORAGE_KEY = 'buildaharness.personal-assistant.config'

const persisted = (): Record<string, unknown> => JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')

async function submit(user: ReturnType<typeof userEvent.setup>, message: string): Promise<void> {
  const input = await screen.findByPlaceholderText('Message Aielia…')
  await user.clear(input)
  await user.type(input, message)
  await user.click(screen.getByRole('button', { name: 'Send' }))
}

describe('App: limits, /project and /undo-action (U4b, U8)', () => {
  beforeEach(() => {
    localStorage.clear()
    setAssistantTestHooks({ makeLlmClient: () => createScriptedLLMClient({ responses: ['One.', 'Two.', 'Three.'], streamChunks: ['One.'] }) })
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    setAssistantTestHooks(null)
    localStorage.clear()
  })

  it('/project shows, switches and clears the active project, and persists the choice', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ llmBackend: 'proxy' }))
    const user = userEvent.setup()
    render(<App />)
    await submit(user, '/project')
    expect(await screen.findByTestId('explain-bubble')).toHaveTextContent('(none)')

    await submit(user, '/project my app')
    await waitFor(() => expect(screen.getAllByTestId('explain-bubble').at(-1)).toHaveTextContent('Active project: my app'))
    await waitFor(() => expect(persisted()).toMatchObject({ activeProject: 'my app' }))

    await submit(user, '/project')
    await waitFor(() => expect(screen.getAllByTestId('explain-bubble').at(-1)).toHaveTextContent('my app'))

    await submit(user, '/project clear')
    await waitFor(() => expect(screen.getAllByTestId('explain-bubble').at(-1)).toHaveTextContent('reset to the workspace default'))
    await waitFor(() => expect(persisted().activeProject).toBeUndefined())
  })

  it('a configured call limit stops the next turn with the shared reason, and no limit changes nothing', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ llmBackend: 'proxy', sessionCallLimit: 1 }))
    const user = userEvent.setup()
    render(<App />)
    await submit(user, 'first question')
    await waitFor(() => expect(document.querySelectorAll('.bubble__content--markdown').length).toBe(1), { timeout: 10000 })
    await submit(user, 'second question')
    const banner = await screen.findByText(/limit/i, { selector: '.escalation-banner *, .escalation-banner' }, { timeout: 10000 })
    expect(banner).toBeInTheDocument()
  })

  it('without a limit, a second turn is answered', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ llmBackend: 'proxy' }))
    const user = userEvent.setup()
    render(<App />)
    await submit(user, 'first question')
    await waitFor(() => expect(document.querySelectorAll('.bubble__content--markdown').length).toBe(1), { timeout: 10000 })
    await submit(user, 'second question')
    await waitFor(() => expect(document.querySelectorAll('.bubble__content--markdown').length).toBe(2), { timeout: 10000 })
    expect(document.querySelector('.escalation-banner')).toBeNull()
  })

  it('/undo-action says there is nothing to revert in a plain browser tab, and reports an unknown id', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ llmBackend: 'proxy' }))
    const user = userEvent.setup()
    render(<App />)
    await submit(user, '/undo-action')
    expect(await screen.findByTestId('explain-bubble')).toHaveTextContent('nothing to revert')
    await submit(user, '/undo-action no-such-id')
    await waitFor(() => expect(screen.getAllByTestId('explain-bubble').at(-1)).toHaveTextContent('✗'))
  })

  it('the Memory panel downloads the learned-memory JSON (formatMemoryExport, the CLI /memory export format)', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ llmBackend: 'proxy' }))
    const blobs: Blob[] = []
    // jsdom has no URL.createObjectURL; download-blob.ts needs both.
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: (b: Blob) => { blobs.push(b); return 'blob:x' }, revokeObjectURL: () => undefined }))
    const user = userEvent.setup()
    render(<App />)
    await screen.findByPlaceholderText('Message Aielia…')
    await user.click(screen.getByRole('button', { name: 'Memory' }))
    await user.click(await screen.findByRole('button', { name: 'Export memory' }))
    await waitFor(() => expect(blobs).toHaveLength(1))
    const exported = JSON.parse(await blobs[0].text())
    expect(exported).toHaveProperty('facts')
    expect(exported).toHaveProperty('experience')
  })
})
