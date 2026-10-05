import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SetupWizard } from './SetupWizard'

const ANT = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz'

function setup(overrides: Partial<React.ComponentProps<typeof SetupWizard>> = {}) {
  const onComplete = vi.fn(async () => {})
  const onSkip = vi.fn()
  render(<SetupWizard isDesktop={false} onComplete={onComplete} onSkip={onSkip} {...overrides} />)
  return { onComplete, onSkip }
}

describe('SetupWizard', () => {
  it('never mentions or offers a Claude login, on desktop or the web build', async () => {
    for (const isDesktop of [true, false]) {
      const { unmount } = render(<SetupWizard isDesktop={isDesktop} onComplete={vi.fn()} onSkip={vi.fn()} />)
      expect(await screen.findByRole('button', { name: /Anthropic/ })).toBeInTheDocument()
      expect(screen.queryByText(/Claude login|Claude Code|already running|no API key/i)).toBeNull()
      unmount()
    }
  })

  it('walks through choosing a provider, validating and saving a key', async () => {
    const testKey = vi.fn(async () => ({ status: 'valid' as const }))
    const { onComplete } = setup({ testKey })
    await userEvent.click(screen.getByRole('button', { name: /Anthropic/ }))
    expect(screen.getByRole('link', { name: /console.anthropic.com/ })).toHaveAttribute('href', 'https://console.anthropic.com/settings/keys')
    await userEvent.type(screen.getByLabelText('API key'), `  ${ANT} `)
    await userEvent.click(screen.getByRole('button', { name: 'Check and start' }))
    expect(testKey).toHaveBeenCalledWith('anthropic', ANT)
    expect(onComplete).toHaveBeenCalledWith({ llmBackend: 'anthropic', apiKey: ANT })
  })

  it('shows an inline error for a key from the wrong provider and does not save', async () => {
    const testKey = vi.fn()
    const { onComplete } = setup({ testKey })
    await userEvent.click(screen.getByRole('button', { name: /Anthropic/ }))
    await userEvent.type(screen.getByLabelText('API key'), 'sk-or-v1-abcdefghijklmnopqrstuvwxyz')
    await userEvent.click(screen.getByRole('button', { name: 'Check and start' }))
    expect(screen.getByRole('alert')).toHaveTextContent(/looks like an OpenRouter key/)
    expect(testKey).not.toHaveBeenCalled()
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('does not save a key the provider rejects', async () => {
    const { onComplete } = setup({ testKey: async () => ({ status: 'invalid', message: 'Anthropic didn’t accept that key.' }) })
    await userEvent.click(screen.getByRole('button', { name: /Anthropic/ }))
    await userEvent.type(screen.getByLabelText('API key'), ANT)
    await userEvent.click(screen.getByRole('button', { name: 'Check and start' }))
    expect(screen.getByRole('alert')).toHaveTextContent(/didn’t accept/)
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('lets the user continue anyway when the key could not be verified', async () => {
    const { onComplete } = setup({ testKey: async () => ({ status: 'unverified', message: 'Are you online?' }) })
    await userEvent.click(screen.getByRole('button', { name: /Anthropic/ }))
    await userEvent.type(screen.getByLabelText('API key'), ANT)
    await userEvent.click(screen.getByRole('button', { name: 'Check and start' }))
    expect(onComplete).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Continue anyway' }))
    expect(onComplete).toHaveBeenCalledWith({ llmBackend: 'anthropic', apiKey: ANT })
  })

  it('hides the key by default and can reveal it', async () => {
    setup()
    await userEvent.click(screen.getByRole('button', { name: /OpenAI/ }))
    expect(screen.getByLabelText('API key')).toHaveAttribute('type', 'password')
    await userEvent.click(screen.getByRole('button', { name: 'Show' }))
    expect(screen.getByLabelText('API key')).toHaveAttribute('type', 'text')
  })

  it('calls onSkip for "Set up later"', async () => {
    const { onSkip } = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Set up later' }))
    expect(onSkip).toHaveBeenCalled()
  })

  it('guides an OpenRouter user through credits, keys and a spending limit', async () => {
    setup()
    await userEvent.click(screen.getByRole('button', { name: /OpenRouter/ }))
    expect(screen.getByText(/Add a few dollars of credit at openrouter.ai\/settings\/credits/)).toBeInTheDocument()
    expect(screen.getByText(/Set a spending limit/)).toBeInTheDocument()
    expect(screen.getByText(/New Guardrail/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /workspaces\/default\/guardrails/ })).toHaveAttribute(
      'href',
      'https://openrouter.ai/workspaces/default/guardrails',
    )
  })

  it('offers copyable links instead of anchors on desktop', async () => {
    setup({ isDesktop: true })
    await userEvent.click(await screen.findByRole('button', { name: /OpenRouter/ }))
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Copy link' }).length).toBe(2)
  })
})
