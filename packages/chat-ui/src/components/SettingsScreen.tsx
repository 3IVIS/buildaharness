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
import { OPENAI_DEFAULT_MODEL, OPENROUTER_DEFAULT_MODEL, type TokenUsage } from '@buildaharness/runtime'
import { ENV_VAR_FOR_CONFIG_KEY } from '../browser-config'

const BACKEND_LABEL: Record<AssistantConfig['llmBackend'], string> = {
  proxy: 'Self-hosted proxy',
  'claude-cli': "Claude CLI (this device's claude session)",
  anthropic: 'Claude API (direct)',
  openai: 'OpenAI API (direct)',
  openrouter: 'OpenRouter API (direct)',
}

/** Shown as the model input's placeholder, not written into the form — an empty field still falls through to each backend's own hardcoded default (LLMClient/AnthropicLLMClient/OpenAICompatibleLLMClient). */
const MODEL_PLACEHOLDER: Record<AssistantConfig['llmBackend'], string> = {
  proxy: 'claude-3-5-sonnet-20241022',
  'claude-cli': '(your Claude Code default)',
  anthropic: 'claude-3-5-sonnet-20241022',
  openai: OPENAI_DEFAULT_MODEL,
  openrouter: OPENROUTER_DEFAULT_MODEL,
}

/** The three backends where the user pastes in their own provider key — see config.ts's AssistantConfig.apiKey doc comment for the trust-boundary tradeoff this implies. */
const DIRECT_API_BACKENDS: ReadonlySet<AssistantConfig['llmBackend']> = new Set(['anthropic', 'openai', 'openrouter'])

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
        <section className="settings__section">
          <h2>Provider</h2>
          <FieldRow label="LLM backend" pinnedBy={pinned('llmBackend') ? ENV_VAR_FOR_CONFIG_KEY.llmBackend : undefined}>
            <select
              aria-label="LLM backend"
              value={form.llmBackend}
              disabled={disabled || pinned('llmBackend')}
              onChange={(e) => set('llmBackend', e.target.value as AssistantConfig['llmBackend'])}
            >
              <option value="proxy">{BACKEND_LABEL.proxy}</option>
              {/* claude-cli needs a real host process to spawn `claude -p` — unavailable in a plain browser tab, see App.tsx's createLlmClient. */}
              {isDesktop && <option value="claude-cli">{BACKEND_LABEL['claude-cli']}</option>}
              <option value="anthropic">{BACKEND_LABEL.anthropic}</option>
              <option value="openai">{BACKEND_LABEL.openai}</option>
              <option value="openrouter">{BACKEND_LABEL.openrouter}</option>
            </select>
          </FieldRow>

          {form.llmBackend === 'proxy' && (
            <>
              <FieldRow label="Proxy URL" pinnedBy={pinned('proxyUrl') ? ENV_VAR_FOR_CONFIG_KEY.proxyUrl : undefined}>
                <input value={form.proxyUrl} disabled={disabled || pinned('proxyUrl')} onChange={(e) => set('proxyUrl', e.target.value)} />
              </FieldRow>
              <FieldRow label="Auth token" pinnedBy={pinned('authToken') ? ENV_VAR_FOR_CONFIG_KEY.authToken : undefined}>
                <input type="password" value={form.authToken} disabled={disabled || pinned('authToken')} onChange={(e) => set('authToken', e.target.value)} />
              </FieldRow>
            </>
          )}

          {DIRECT_API_BACKENDS.has(form.llmBackend) && (
            <>
              <FieldRow label="API key" pinnedBy={pinned('apiKey') ? ENV_VAR_FOR_CONFIG_KEY.apiKey : undefined}>
                <input
                  type="password"
                  value={form.apiKey ?? ''}
                  disabled={disabled || pinned('apiKey')}
                  onChange={(e) => set('apiKey', e.target.value || undefined)}
                />
              </FieldRow>
              <p className="settings__warning">
                Stored in plain text on this device, not an OS keychain — same trust boundary as the other secret
                fields on this screen, but this is a real {BACKEND_LABEL[form.llmBackend]} key, not a self-hosted
                proxy token, so a leaked config file is a bigger deal. Only enter a key you're comfortable having
                sit in a local settings file.
              </p>
            </>
          )}

          <FieldRow label="Model" pinnedBy={pinned('model') ? ENV_VAR_FOR_CONFIG_KEY.model : undefined}>
            <input
              value={form.model ?? ''}
              disabled={disabled || pinned('model')}
              placeholder={MODEL_PLACEHOLDER[form.llmBackend]}
              onChange={(e) => set('model', e.target.value || undefined)}
            />
          </FieldRow>
        </section>

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
              backend: config.llmBackend,
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
