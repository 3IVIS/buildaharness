import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from './App'

vi.mock('@buildaharness/runtime', async () => {
  const actual = await vi.importActual<typeof import('@buildaharness/runtime')>('@buildaharness/runtime')
  return { ...actual, LLMClient: vi.fn() }
})

vi.mock('@buildaharness/personal-assistant', async () => {
  const actual = await vi.importActual<typeof import('@buildaharness/personal-assistant')>('@buildaharness/personal-assistant')
  return {
    ...actual,
    PersonalAssistant: {
      create: vi.fn(async () => ({
        turn: vi.fn(async (message: string, options?: { approved?: boolean }) => {
          if (message.includes('approval') && !options?.approved) {
            return { status: 'needs_approval', reply: null, reason: 'looks risky', riskLevel: 'HIGH' }
          }
          return { status: 'ok', reply: `echo: ${message}`, riskLevel: 'LOW' }
        }),
      })),
    },
  }
})

describe('App', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
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
})
