import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DEFAULT_CONFIG, type AssistantConfig } from '@buildaharness/personal-assistant'
import { SettingsScreen } from './SettingsScreen'

function renderSettings(overrides: Partial<React.ComponentProps<typeof SettingsScreen>> = {}) {
  const onSave = vi.fn(async () => {})
  const onCancel = vi.fn()
  const result = render(
    <SettingsScreen
      config={DEFAULT_CONFIG}
      overriddenKeys={new Set()}
      isDesktop={false}
      busy={false}
      onSave={onSave}
      onCancel={onCancel}
      transcriptLength={0}
      memorySummary={null}
      healthChecks={null}
      {...overrides}
    />,
  )
  return { onSave, onCancel, ...result }
}

describe('SettingsScreen', () => {
  it('renders the currently resolved config values on open', () => {
    renderSettings({ config: { ...DEFAULT_CONFIG, proxyUrl: 'http://example:1234' } })
    expect(screen.getByDisplayValue('http://example:1234')).toBeInTheDocument()
  })

  it('shows the Provider section on the browser path', () => {
    renderSettings({ isDesktop: false })
    expect(screen.getByText('Provider')).toBeInTheDocument()
  })

  it('shows the Provider section on the desktop path too', () => {
    renderSettings({ isDesktop: true })
    expect(screen.getByText('Provider')).toBeInTheDocument()
  })

  it('offers "Claude CLI" as a backend option only on the desktop path', () => {
    const { unmount } = renderSettings({ isDesktop: false })
    expect(screen.queryByRole('option', { name: /Claude CLI/ })).not.toBeInTheDocument()
    unmount()

    renderSettings({ isDesktop: true })
    expect(screen.getByRole('option', { name: /Claude CLI/ })).toBeInTheDocument()
  })

  it('shows the Workspace section only on the desktop path', () => {
    const { rerender } = render(
      <SettingsScreen
        config={DEFAULT_CONFIG}
        overriddenKeys={new Set()}
        isDesktop={false}
        busy={false}
        onSave={vi.fn()}
        onCancel={vi.fn()}
        transcriptLength={0}
        memorySummary={null}
        healthChecks={null}
      />,
    )
    expect(screen.queryByText('Workspace')).not.toBeInTheDocument()
    rerender(
      <SettingsScreen
        config={DEFAULT_CONFIG}
        overriddenKeys={new Set()}
        isDesktop
        busy={false}
        onSave={vi.fn()}
        onCancel={vi.fn()}
        transcriptLength={0}
        memorySummary={null}
        healthChecks={null}
      />,
    )
    expect(screen.getByText('Workspace')).toBeInTheDocument()
  })

  it('Brave API key field is hidden unless searchBackend is set to brave in the form', async () => {
    const user = userEvent.setup()
    renderSettings({ config: { ...DEFAULT_CONFIG, enableWeb: true } })
    expect(screen.queryByText('Brave API key')).not.toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Search backend'), 'brave')
    expect(screen.getByText('Brave API key')).toBeInTheDocument()
  })

  it('an env-pinned field renders as a disabled input with a note', () => {
    renderSettings({ overriddenKeys: new Set<keyof AssistantConfig>(['proxyUrl']) })
    expect(screen.getByText(/pinned by/)).toBeInTheDocument()
    expect(screen.getByDisplayValue(DEFAULT_CONFIG.proxyUrl)).toBeDisabled()
  })

  it('Save calls onSave with only the changed keys and returns to chat view', async () => {
    const user = userEvent.setup()
    const { onSave } = renderSettings()
    const proxyInput = screen.getByDisplayValue(DEFAULT_CONFIG.proxyUrl)
    await user.clear(proxyInput)
    await user.type(proxyInput, 'http://changed:1')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith({ proxyUrl: 'http://changed:1' })
  })

  it('Save is disabled while a turn is in flight (busy)', () => {
    renderSettings({ busy: true })
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  })

  it('Cancel discards edits without calling onSave', async () => {
    const user = userEvent.setup()
    const { onSave, onCancel } = renderSettings()
    const proxyInput = screen.getByDisplayValue(DEFAULT_CONFIG.proxyUrl)
    await user.type(proxyInput, 'http://changed:1')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onSave).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalled()
  })

  it('an invalid combination (brave selected, no key) shows a validation error and does not call onSave', async () => {
    const user = userEvent.setup()
    const { onSave } = renderSettings({ config: { ...DEFAULT_CONFIG, enableWeb: true } })
    await user.selectOptions(screen.getByLabelText('Search backend'), 'brave')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByText(/requires braveApiKey/)).toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
  })

  describe('Provider backend selection', () => {
    it('shows Proxy URL/Auth token only for the "proxy" backend', async () => {
      const user = userEvent.setup()
      renderSettings()
      expect(screen.getByText('Proxy URL')).toBeInTheDocument()
      expect(screen.getByText('Auth token')).toBeInTheDocument()

      await user.selectOptions(screen.getByLabelText('LLM backend'), 'anthropic')
      expect(screen.queryByText('Proxy URL')).not.toBeInTheDocument()
      expect(screen.queryByText('Auth token')).not.toBeInTheDocument()
    })

    it.each(['anthropic', 'openai', 'openrouter'])('shows a masked API key field and a plaintext-storage warning for "%s"', async (backend) => {
      const user = userEvent.setup()
      renderSettings()
      await user.selectOptions(screen.getByLabelText('LLM backend'), backend)

      const apiKeyInput = screen.getByText('API key').closest('label')?.querySelector('input')
      expect(apiKeyInput).toHaveAttribute('type', 'password')
      expect(screen.getByText(/plain text on this device/)).toBeInTheDocument()
    })

    it('shows no Proxy URL/Auth token/API key fields for "claude-cli" — relies on the host session', async () => {
      const user = userEvent.setup()
      renderSettings({ isDesktop: true })
      await user.selectOptions(screen.getByLabelText('LLM backend'), 'claude-cli')

      expect(screen.queryByText('Proxy URL')).not.toBeInTheDocument()
      expect(screen.queryByText('Auth token')).not.toBeInTheDocument()
      expect(screen.queryByText('API key')).not.toBeInTheDocument()
    })

    it('always shows the Model field, with a backend-specific placeholder', async () => {
      const user = userEvent.setup()
      renderSettings()
      expect(screen.getByPlaceholderText('claude-3-5-sonnet-20241022')).toBeInTheDocument()

      await user.selectOptions(screen.getByLabelText('LLM backend'), 'openai')
      expect(screen.getByPlaceholderText('gpt-4o-mini')).toBeInTheDocument()
    })

    it("Save's changed-keys diff includes apiKey when switching to a direct backend", async () => {
      const user = userEvent.setup()
      const { onSave } = renderSettings()

      await user.selectOptions(screen.getByLabelText('LLM backend'), 'anthropic')
      await user.type(screen.getByText('API key').closest('label')!.querySelector('input')!, 'sk-ant-test')
      await user.click(screen.getByRole('button', { name: 'Save' }))

      expect(onSave).toHaveBeenCalledWith({ llmBackend: 'anthropic', apiKey: 'sk-ant-test' })
    })
  })

  describe('Diagnostics section', () => {
    it('shows "Loading…"/"Checking…" placeholders while memory/health data has not arrived yet', () => {
      renderSettings({ memorySummary: null, healthChecks: null })
      expect(screen.getByText('Loading…')).toBeInTheDocument()
      expect(screen.getByText('Checking…')).toBeInTheDocument()
    })

    it('renders memory summary once loaded', () => {
      renderSettings({
        memorySummary: {
          facts: [{ text: 'My name is Ali.', extractedAt: '2026-01-01T00:00:00.000Z', sourceTurn: 'turn:test', durable: true }],
          reminders: [],
          experience: { strategyWeightCount: 0, decompositionCount: 0, recoverySequenceCount: 0 },
        },
      })
      expect(screen.getByText(/My name is Ali\./)).toBeInTheDocument()
    })

    it('renders session transcript length', () => {
      renderSettings({ transcriptLength: 4 })
      expect(screen.getByText(/4 messages this session/)).toBeInTheDocument()
    })

    it('renders health checks once loaded, including a failing one', () => {
      renderSettings({ healthChecks: [{ label: 'proxy reachable', ok: false, detail: 'timed out' }] })
      expect(screen.getByText(/proxy reachable — timed out/)).toBeInTheDocument()
    })

    it('renders usage/cost once a turn has completed', () => {
      renderSettings({
        lastTurnUsage: { inputTokens: 100, outputTokens: 50 },
        sessionUsage: { inputTokens: 100, outputTokens: 50 },
      })
      expect(screen.getByText(/100 in \/ 50 out tokens/)).toBeInTheDocument()
    })
  })
})
