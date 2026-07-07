import { useState } from 'react'
import {
  validateConfig,
  ConfigValidationError,
  CONFIG_KEYS,
  formatMemorySummary,
  formatCostSummary,
  formatDoctorReport,
  type AssistantConfig,
  type MemorySummary,
  type DoctorCheck,
} from '@buildaharness/personal-assistant'
import type { TokenUsage } from '@buildaharness/runtime'
import { ENV_VAR_FOR_CONFIG_KEY } from '../browser-config'

interface Props {
  config: AssistantConfig
  overriddenKeys: ReadonlySet<keyof AssistantConfig>
  /** Hides the Connection section (proxy/token/model don't apply — desktop always talks to the user's own claude-cli session) and shows the Workspace section instead. */
  isDesktop: boolean
  /** True while a turn is in flight — Save/Cancel disable rather than racing a live turn. */
  busy: boolean
  onSave: (patch: Partial<AssistantConfig>) => Promise<void>
  onCancel: () => void
  /** Desktop-only: opens the native folder picker (Tauri's pick_workspace_directory command). Resolves null if the user cancelled. */
  onPickWorkspaceDirectory?: () => Promise<string | null>
  /** GUI equivalents of the CLI's /status (transcript length), /memory, /cost, and /doctor — App.tsx populates these when Settings opens (see loadDiagnostics). null/undefined means "still loading", not "empty". */
  transcriptLength: number
  memorySummary: MemorySummary | null
  lastTurnUsage?: TokenUsage
  sessionUsage?: TokenUsage
  healthChecks: DoctorCheck[] | null
}

function isPinned(overriddenKeys: ReadonlySet<keyof AssistantConfig>, key: keyof AssistantConfig): boolean {
  return overriddenKeys.has(key)
}

function FieldRow({ label, pinnedBy, children }: { label: string; pinnedBy?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <label className="settings__field">
      <span className="settings__field-label">
        {label}
        {pinnedBy ? <span className="settings__pinned"> (pinned by {pinnedBy})</span> : null}
      </span>
      {children}
    </label>
  )
}

export function SettingsScreen({
  config,
  overriddenKeys,
  isDesktop,
  busy,
  onSave,
  onCancel,
  onPickWorkspaceDirectory,
  transcriptLength,
  memorySummary,
  lastTurnUsage,
  sessionUsage,
  healthChecks,
}: Props): React.JSX.Element {
  const [form, setForm] = useState<AssistantConfig>(config)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  function set<K extends keyof AssistantConfig>(key: K, value: AssistantConfig[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function pinned(key: keyof AssistantConfig): boolean {
    return isPinned(overriddenKeys, key)
  }

  async function handleSave(): Promise<void> {
    setError(null)
    try {
      validateConfig(form, config)
    } catch (err) {
      setError(err instanceof ConfigValidationError ? err.message : 'Invalid settings.')
      return
    }

    // Only the keys that actually changed — pinned fields render disabled inputs above, so
    // form[key] never diverges from config[key] for those; this patch can never touch them.
    const patch: Partial<AssistantConfig> = {}
    for (const key of CONFIG_KEYS) {
      if (form[key] !== config[key]) Object.assign(patch, { [key]: form[key] })
    }

    setSaving(true)
    try {
      await onSave(patch)
    } finally {
      setSaving(false)
    }
  }

  async function handlePickWorkspace(): Promise<void> {
    if (!onPickWorkspaceDirectory) return
    const path = await onPickWorkspaceDirectory()
    if (path) set('workspaceRoot', path)
  }

  const disabled = saving || busy

  return (
    <div className="settings">
      <div className="settings__header">
        <button type="button" className="settings__back" onClick={onCancel} disabled={disabled}>← Back</button>
        <div className="settings__title">Settings</div>
      </div>

      <div className="settings__body">
        {!isDesktop && (
          <section className="settings__section">
            <h2>Connection</h2>
            <FieldRow label="Proxy URL" pinnedBy={pinned('proxyUrl') ? ENV_VAR_FOR_CONFIG_KEY.proxyUrl : undefined}>
              <input value={form.proxyUrl} disabled={disabled || pinned('proxyUrl')} onChange={(e) => set('proxyUrl', e.target.value)} />
            </FieldRow>
            <FieldRow label="Auth token" pinnedBy={pinned('authToken') ? ENV_VAR_FOR_CONFIG_KEY.authToken : undefined}>
              <input type="password" value={form.authToken} disabled={disabled || pinned('authToken')} onChange={(e) => set('authToken', e.target.value)} />
            </FieldRow>
            <FieldRow label="Model" pinnedBy={pinned('model') ? ENV_VAR_FOR_CONFIG_KEY.model : undefined}>
              <input
                value={form.model ?? ''}
                disabled={disabled || pinned('model')}
                placeholder="(provider default)"
                onChange={(e) => set('model', e.target.value || undefined)}
              />
            </FieldRow>
          </section>
        )}

        <section className="settings__section">
          <h2>Web search</h2>
          <FieldRow label="Enable web search / fetch">
            <input type="checkbox" checked={form.enableWeb} disabled={disabled} onChange={(e) => set('enableWeb', e.target.checked)} />
          </FieldRow>
          {form.enableWeb && (
            <>
              <FieldRow label="Search backend">
                <select
                  value={form.searchBackend}
                  disabled={disabled}
                  onChange={(e) => set('searchBackend', e.target.value as AssistantConfig['searchBackend'])}
                >
                  <option value="ddg">DuckDuckGo (no key needed)</option>
                  <option value="brave">Brave Search API</option>
                </select>
              </FieldRow>
              {form.searchBackend === 'brave' && (
                <FieldRow label="Brave API key">
                  <input
                    type="password"
                    value={form.braveApiKey ?? ''}
                    disabled={disabled}
                    onChange={(e) => set('braveApiKey', e.target.value || undefined)}
                  />
                </FieldRow>
              )}
            </>
          )}
        </section>

        <section className="settings__section">
          <h2>Shell</h2>
          <FieldRow label="Enable shell commands (approval-gated)">
            <input type="checkbox" checked={form.enableShell} disabled={disabled} onChange={(e) => set('enableShell', e.target.checked)} />
          </FieldRow>
          {form.enableShell && (
            <FieldRow label="Timeout (ms)">
              <input
                type="number"
                value={form.shellTimeoutMs ?? ''}
                disabled={disabled}
                onChange={(e) => set('shellTimeoutMs', e.target.value ? Number(e.target.value) : undefined)}
              />
            </FieldRow>
          )}
        </section>

        <section className="settings__section">
          <h2>Advanced</h2>
          <FieldRow label="⚠ Dangerously skip permissions">
            <input
              type="checkbox"
              checked={form.dangerouslySkipPermissions}
              disabled={disabled}
              onChange={(e) => set('dangerouslySkipPermissions', e.target.checked)}
            />
          </FieldRow>
          {form.dangerouslySkipPermissions && (
            <p className="settings__warning">
              Every approval prompt — risky-message confirmation, file-write review, shell-command review — is
              skipped automatically. Sandboxing itself (workspace scoping, timeouts, output limits) still applies;
              only the "ask first" step is gone. Equivalent to Claude Code's own --dangerously-skip-permissions.
            </p>
          )}
        </section>

        {isDesktop && (
          <section className="settings__section">
            <h2>Workspace</h2>
            <FieldRow label="Directory">
              <div className="settings__workspace-row">
                <span className="settings__workspace-path">{form.workspaceRoot ?? '(using repo dev workspace)'}</span>
                <button type="button" onClick={handlePickWorkspace} disabled={disabled}>Choose…</button>
              </div>
            </FieldRow>
          </section>
        )}

        <section className="settings__section">
          <h2>Diagnostics</h2>
          <div className="settings__field-label">Session</div>
          <pre className="settings__diagnostics-block">{transcriptLength} message{transcriptLength === 1 ? '' : 's'} this session</pre>

          <div className="settings__field-label">Memory</div>
          <pre className="settings__diagnostics-block">{memorySummary ? formatMemorySummary(memorySummary) : 'Loading…'}</pre>

          <div className="settings__field-label">Usage</div>
          <pre className="settings__diagnostics-block">
            {formatCostSummary({
              lastTurn: lastTurnUsage,
              session: sessionUsage ?? { inputTokens: 0, outputTokens: 0 },
              backend: isDesktop ? 'claude-cli' : 'proxy',
            })}
          </pre>

          <div className="settings__field-label">Health</div>
          <pre className="settings__diagnostics-block">{healthChecks ? formatDoctorReport(healthChecks) : 'Checking…'}</pre>
        </section>

        {error && <div className="settings__error">{error}</div>}
      </div>

      <div className="settings__footer">
        <button type="button" className="settings__save" onClick={() => void handleSave()} disabled={disabled}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={onCancel} disabled={disabled}>Cancel</button>
      </div>
    </div>
  )
}
