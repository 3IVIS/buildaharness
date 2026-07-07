import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DEFAULT_CONFIG, type AssistantConfig } from '@buildaharness/personal-assistant'
import { SettingsScreen } from './SettingsScreen'

function renderSettings(overrides: Partial<React.ComponentProps<typeof SettingsScreen>> = {}) {
  const onSave = vi.fn(async () => {})
  const onCancel = vi.fn()
  render(
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
  return { onSave, onCancel }
}

describe('SettingsScreen', () => {
  it('renders the currently resolved config values on open', () => {
    renderSettings({ config: { ...DEFAULT_CONFIG, proxyUrl: 'http://example:1234' } })
    expect(screen.getByDisplayValue('http://example:1234')).toBeInTheDocument()
  })

  it('hides the Connection section on the desktop path', () => {
    renderSettings({ isDesktop: true })
    expect(screen.queryByText('Connection')).not.toBeInTheDocument()
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
    await user.selectOptions(screen.getByRole('combobox'), 'brave')
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
    await user.selectOptions(screen.getByRole('combobox'), 'brave')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByText(/requires braveApiKey/)).toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
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
          facts: [{ text: 'My name is Ali.', extractedAt: '2026-01-01T00:00:00.000Z', sourceTurn: 'turn:test' }],
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
