import { describe, it, expect, vi, beforeEach } from 'vitest'
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
})
