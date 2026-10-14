import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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

describe('App: limits and /project (U4b)', () => {
  beforeEach(() => {
    localStorage.clear()
    setAssistantTestHooks({ makeLlmClient: () => createScriptedLLMClient({ responses: ['One.', 'Two.', 'Three.'], streamChunks: ['One.'] }) })
  })
  afterEach(() => {
    cleanup()
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
})
