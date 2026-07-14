import { useEffect, useRef, useState } from 'react'
import { isTauri, invoke } from '@tauri-apps/api/core'
import {
  PersonalAssistant,
  nodeDisplayName,
  classifyError,
  resolveConfig,
  estimateCostUsd,
  formatTranscriptMarkdown,
  defaultExportFilename,
  duckDuckGoSearch,
  braveSearch,
  type AssistantProgress,
  type AssistantToolStep,
  type AssistantConfig,
  type ConfigStore,
  type MemorySummary,
  type DoctorCheck,
  type WebSearchResult,
  type DnsResolver,
  type AssistantTurnResult,
  type DebugLogEntry,
} from '@buildaharness/personal-assistant'
import {
  LLMClient,
  AnthropicLLMClient,
  OpenAICompatibleLLMClient,
  OPENAI_BASE_URL,
  OPENAI_DEFAULT_MODEL,
  OPENROUTER_BASE_URL,
  OPENROUTER_DEFAULT_MODEL,
  OPENROUTER_EXTRA_HEADERS,
  FileSystemAdapter,
  FileSystemExperienceStore,
  type ILLMClient,
  type TokenUsage,
} from '@buildaharness/runtime'
import { TauriClaudeCliLLMClient } from './tauri-claude-cli-llm-client'
import { tauriExecuteShellCommand } from './tauri-shell-executor'
import { ChatMessageBubble } from './components/ChatMessageBubble'
import { ApprovalCard } from './components/ApprovalCard'
import { EscalationBanner } from './components/EscalationBanner'
import { SettingsScreen } from './components/SettingsScreen'
import { BrowserConfigStore } from './browser-config-store'
import { TauriConfigStore } from './tauri-config-store'
import { envOverridesFromImportMetaEnv } from './browser-config'
import { checkProxyReachable, checkClaudeAvailable, checkWorkspaceConfigured, checkDataDirWritable } from './gui-doctor-checks'
import type { ChatEntry } from './types'

/** Same fixed default the proxy backend's LLMClient itself falls back to (see @buildaharness/runtime's llm-client.ts) — used only to pick a pricing tier when no model is explicitly configured. */
const DEFAULT_PROXY_MODEL = 'claude-3-5-sonnet-20241022'

/**
 * Full conversation content (user messages, assistant replies, real tool calls with their
 * actual results) for live debugging — deliberately opt-in and separate from onTrace (see
 * DebugLogEntry's doc comment). On desktop, forwarded through @tauri-apps/plugin-log's `info`
 * to the Rust logger already registered in src-tauri/src/lib.rs (`tauri_plugin_log`, debug
 * builds only) — that's what makes it show up in the terminal running `tauri dev`, not just
 * this webview's own (otherwise invisible from outside) DevTools console. A plain browser tab
 * has no such bridge, so it falls back to console.debug there.
 */
function debugLog(entry: DebugLogEntry): void {
  const line = `[assistant:${entry.kind}] ${entry.content}`
  if (isTauri()) {
    void import('@tauri-apps/plugin-log').then(({ info }) => info(line))
  } else {
    console.debug(line)
  }
}

function accumulateUsage(prev: TokenUsage | undefined, usage: TokenUsage): TokenUsage {
  return {
    inputTokens: (prev?.inputTokens ?? 0) + usage.inputTokens,
    outputTokens: (prev?.outputTokens ?? 0) + usage.outputTokens,
    costUsd: usage.costUsd !== undefined ? (prev?.costUsd ?? 0) + usage.costUsd : prev?.costUsd,
  }
}

// Env/build-time vars still win over persisted config — see browser-config.ts and
// config.ts's resolveConfig — so nothing changes for a deployed build that already sets
// VITE_ASSISTANT_PROXY_URL/_TOKEN/_MODEL and never opens Settings.
const envOverrides = envOverridesFromImportMetaEnv(import.meta.env)

function newId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
}

/**
 * Builds the webTools context (search, fetchImpl, dns) for web_search/fetch_url.
 *
 * fetchImpl: DuckDuckGo's HTML-scraping endpoint (and Brave's/fetch_url's arbitrary target)
 * aren't CORS-enabled for arbitrary browser origins, so a plain `fetch()` from inside this
 * app fails outright with "Failed to fetch" (verified live). On desktop this is fixed by
 * routing through @tauri-apps/plugin-http's fetch — a real HTTP request made from Rust, no
 * CORS involved. Scoped via capabilities/default.json's `http:default` entry to any http(s)
 * URL (originally just html.duckduckgo.com/api.search.brave.com, which left fetch_url's
 * arbitrary targets CORS-blocked on desktop — widened once fetch_url needed real page fetches
 * too); the real gate against SSRF is the DNS-checked `assertPublicHttpUrl` guard below, not
 * this scope. A plain browser tab has no equivalent escape hatch and is left on native fetch.
 *
 * dns: fetch_url's SSRF guard (web-tools.ts's assertPublicHttpUrl) defaults to
 * `node:dns/promises`, which doesn't exist in any webview or browser tab — without an
 * override it throws on every fetch_url call, not just an occasional failure. Desktop gets
 * a real resolver (tauriDnsResolver, backed by the dns_lookup Tauri command); a plain
 * browser tab has no DNS API available at all and is left on the (always-failing) default,
 * same "capability absent, not a crash" degradation as everywhere else this app can't fully
 * support something — the failure is caught by assistant.ts's tool dispatch and reported to
 * the model as an error result, never a crashed turn.
 */
async function createWebTools(config: AssistantConfig, isDesktop: boolean): Promise<{ search: (query: string) => Promise<WebSearchResult[]>; fetchImpl?: typeof fetch; dns?: DnsResolver }> {
  const fetchImpl = isDesktop ? (await import('@tauri-apps/plugin-http')).fetch : undefined
  const dns = isDesktop ? (await import('./tauri-dns-resolver')).tauriDnsResolver : undefined
  const search =
    config.searchBackend === 'brave'
      ? (query: string) => braveSearch(query, config.braveApiKey ?? '', { fetchImpl })
      : (query: string) => duckDuckGoSearch(query, { fetchImpl })
  return { search, fetchImpl, dns }
}

/** Picks the platform-appropriate ConfigStore — localStorage in a plain browser, a Tauri-fs-backed JSON file on desktop (same appLocalDataDir already used for transcripts). */
async function createConfigStore(): Promise<ConfigStore> {
  if (!isTauri()) return new BrowserConfigStore()
  const [{ appLocalDataDir }, { createTauriFsBackend }] = await Promise.all([
    import('@tauri-apps/api/path'),
    import('./tauri-fs-backend'),
  ])
  return new TauriConfigStore({ backend: createTauriFsBackend(), baseDir: await appLocalDataDir() })
}

/**
 * Picks the ILLMClient for config.llmBackend — shared by the plain-browser and desktop build
 * paths (buildAssistant / createTauriBackedAssistant below) so both surfaces resolve the same
 * 5 backend values identically instead of the desktop path hardcoding claude-cli as the only
 * option, which it used to (see git history — createTauriBackedAssistant previously always
 * constructed a TauriClaudeCliLLMClient, ignoring config.llmBackend entirely).
 *
 * 'claude-cli' only works on the desktop build (a Tauri Rust command runs `claude -p` on the
 * host) — a plain browser tab has no way to spawn a subprocess at all, so requesting it there
 * degrades to 'proxy' with a console warning rather than throwing an unhandled error the user
 * would just see as "Something went wrong" with no actionable cause.
 *
 * The three direct-API backends (anthropic/openai/openrouter) work identically on both
 * surfaces — `fetch()` to the provider is available in a plain browser tab and inside Tauri's
 * webview alike, so this is the one part of client selection that needs no isDesktop branch.
 */
function createLlmClient(config: AssistantConfig, { isDesktop, workspaceRoot }: { isDesktop: boolean; workspaceRoot: string }): ILLMClient {
  switch (config.llmBackend) {
    case 'claude-cli':
      if (isDesktop) return new TauriClaudeCliLLMClient({ fileTools: { workspaceRoot }, shellTools: config.enableShell })
      console.warn('llmBackend "claude-cli" isn\'t available in a plain browser tab (no way to run `claude -p`) — falling back to "proxy".')
      return new LLMClient({ proxyUrl: config.proxyUrl, authToken: config.authToken })
    case 'anthropic':
      return new AnthropicLLMClient({ apiKey: config.apiKey ?? '' })
    case 'openai':
      return new OpenAICompatibleLLMClient({ apiKey: config.apiKey ?? '', baseUrl: OPENAI_BASE_URL, defaultModel: OPENAI_DEFAULT_MODEL })
    case 'openrouter':
      return new OpenAICompatibleLLMClient({
        apiKey: config.apiKey ?? '',
        baseUrl: OPENROUTER_BASE_URL,
        defaultModel: OPENROUTER_DEFAULT_MODEL,
        extraHeaders: OPENROUTER_EXTRA_HEADERS,
      })
    case 'proxy':
      return new LLMClient({ proxyUrl: config.proxyUrl, authToken: config.authToken })
  }
}

/**
 * PersonalAssistant.create() only defaults storage that isn't already supplied
 * (browser → Dexie), so passing filesystem-backed stores here is what gives the
 * desktop build real persistence instead of the IndexedDB it'd otherwise pick.
 * @tauri-apps/plugin-fs is dynamically imported so a plain (non-Tauri) browser
 * build never has to load it. See plans/tauri_desktop_plan.html Phase 3.
 *
 * llmClient now comes from the shared createLlmClient() — desktop can use any of the 5
 * backends, not just claude-cli (see that function's doc comment for why this changed).
 *
 * fileTools is wired to `config.workspaceRoot` if the user has picked one via the Settings
 * screen's Workspace section, falling back to `get_dev_workspace_root()` (the monorepo root,
 * computed on the Rust side from this crate's compile-time location — see that command's own
 * doc comment) otherwise. shellTools follows the same enableShell gate the CLI uses
 * (cli.ts) — `run_shell_command` is only registered on the MCP server, and only wired into
 * PersonalAssistant, when the user has turned Shell on in Settings. Note:
 * `config.enableWeb`/`searchBackend` are still persisted and shown in Settings for schema
 * consistency with the CLI but chat-ui has no web_search/fetch_url wiring of its own yet —
 * that toggle alone doesn't change behavior here.
 *
 * fileTools/shellTools deliberately use a *different* FsBackend (createTauriWorkspaceFsBackend)
 * than memory/experienceStore/checkpointStore do (createTauriFsBackend) — the former is
 * workspace-root-scoped via raw Rust std::fs commands, the latter is $APPLOCALDATA-scoped via
 * @tauri-apps/plugin-fs's capability system. Using the $APPLOCALDATA-scoped one against a
 * workspaceRoot path (which is never under $APPLOCALDATA) used to fail every write_file/
 * run_shell_command call with a "forbidden path" error — see tauri-workspace-fs-backend.ts's
 * doc comment for the full story.
 */
async function createTauriBackedAssistant(config: AssistantConfig): Promise<PersonalAssistant> {
  const [{ appLocalDataDir }, { createTauriFsBackend }, { createTauriWorkspaceFsBackend }] = await Promise.all([
    import('@tauri-apps/api/path'),
    import('./tauri-fs-backend'),
    import('./tauri-workspace-fs-backend'),
  ])
  const baseDir = await appLocalDataDir()
  const backend = createTauriFsBackend()
  const workspaceRoot = config.workspaceRoot ?? (await invoke<string>('get_dev_workspace_root'))
  const workspaceBackend = createTauriWorkspaceFsBackend(workspaceRoot)

  return PersonalAssistant.create({
    llmClient: createLlmClient(config, { isDesktop: true, workspaceRoot }),
    model: config.model,
    memory: new FileSystemAdapter({ backend, baseDir, namespace: 'transcripts' }),
    experienceStore: await FileSystemExperienceStore.create({ backend, baseDir, namespace: 'experience' }),
    checkpointStore: new FileSystemAdapter({ backend, baseDir, namespace: 'checkpoints' }),
    fileTools: { backend: workspaceBackend, workspaceRoot },
    webTools: config.enableWeb ? await createWebTools(config, true) : undefined,
    shellTools: config.enableShell
      ? { backend: workspaceBackend, workspaceRoot, timeoutMs: config.shellTimeoutMs, executeCommand: tauriExecuteShellCommand }
      : undefined,
    dangerouslySkipPermissions: config.dangerouslySkipPermissions,
    onDebugLog: debugLog,
  })
}

async function buildAssistant(config: AssistantConfig): Promise<PersonalAssistant> {
  if (isTauri()) return createTauriBackedAssistant(config)
  return PersonalAssistant.create({
    llmClient: createLlmClient(config, { isDesktop: false, workspaceRoot: '' }),
    model: config.model,
    // No fileTools/shellTools in a plain browser build (no filesystem/process access at all) —
    // still worth honoring dangerouslySkipPermissions for consistency with the desktop build,
    // since it also affects the message-level risk gate, independent of file/shell tools.
    webTools: config.enableWeb ? await createWebTools(config, false) : undefined,
    dangerouslySkipPermissions: config.dangerouslySkipPermissions,
    onDebugLog: debugLog,
  })
}

export function App(): React.JSX.Element {
  const [entries, setEntries] = useState<ChatEntry[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<AssistantProgress | null>(null)
  const [streamingText, setStreamingText] = useState<string | null>(null)
  const [liveToolSteps, setLiveToolSteps] = useState<AssistantToolStep[]>([])
  const [view, setView] = useState<'chat' | 'settings'>('chat')
  // Optimistic default so Settings is usable immediately — refreshed to the real persisted
  // value once createConfigStore().load() resolves, a moment later (see the mount effect).
  const initialResolved = resolveConfig({}, envOverrides)
  const [config, setConfig] = useState<AssistantConfig>(initialResolved.config)
  const [overriddenKeys, setOverriddenKeys] = useState<ReadonlySet<keyof AssistantConfig>>(initialResolved.overriddenKeys)
  // GUI equivalents of the CLI's /cost, /memory, /doctor, and /status (transcript length) —
  // populated on demand (usage as each turn completes; memory/health/transcript length when
  // Settings opens) rather than kept live at all times, the same "compute when asked for"
  // spirit the CLI commands have.
  const [lastTurnUsage, setLastTurnUsage] = useState<TokenUsage | undefined>(undefined)
  const [sessionUsage, setSessionUsage] = useState<TokenUsage | undefined>(undefined)
  const [memorySummary, setMemorySummary] = useState<MemorySummary | null>(null)
  const [healthChecks, setHealthChecks] = useState<DoctorCheck[] | null>(null)
  const [transcriptLength, setTranscriptLength] = useState(0)
  // Phase 3.2 of the harness layer activation plan: a persistent strip above the composer,
  // visible only while a durable plan is actually driving the session — set from each turn's
  // planStatus (present whenever a plan drove that turn, including a Phase-4 pause), cleared
  // once a turn completes with no plan behind it (finished/abandoned).
  const [activePlanStatus, setActivePlanStatus] = useState<AssistantTurnResult['planStatus']>(undefined)
  const assistantRef = useRef<PersonalAssistant | null>(null)
  const configStoreRef = useRef<ConfigStore | null>(null)
  const sessionIdRef = useRef(newId())
  const bottomRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)

  /**
   * claude-cli (via TauriClaudeCliLLMClient, desktop-only) is the only backend that returns a
   * real dollar cost — every other backend (proxy, and now anthropic/openai/openrouter, which
   * work identically on both browser and desktop — see createLlmClient) gets the same
   * static-table estimate the CLI's /cost uses instead. Used to be gated on isTauri() alone,
   * back when desktop could only ever be running claude-cli; that's no longer true.
   */
  function withCostEstimate(usage: TokenUsage): TokenUsage {
    if (config.llmBackend === 'claude-cli' || usage.costUsd !== undefined) return usage
    const estimated = estimateCostUsd(config.model ?? DEFAULT_PROXY_MODEL, usage)
    return estimated !== undefined ? { ...usage, costUsd: estimated } : usage
  }

  /** Runs the platform-appropriate health checks — proxy reachability in a plain browser, claude/workspace/data-dir on desktop (see gui-doctor-checks.ts). */
  async function runHealthChecks(): Promise<DoctorCheck[]> {
    if (!isTauri()) return [await checkProxyReachable(config.proxyUrl)]

    const [{ appLocalDataDir }, { createTauriFsBackend }] = await Promise.all([
      import('@tauri-apps/api/path'),
      import('./tauri-fs-backend'),
    ])
    const baseDir = await appLocalDataDir()
    const backend = createTauriFsBackend()
    return Promise.all([
      checkClaudeAvailable(),
      Promise.resolve(checkWorkspaceConfigured(config.workspaceRoot)),
      checkDataDirWritable(backend, baseDir),
    ])
  }

  /** Populates the Diagnostics section's data — called when Settings opens, not kept live, since Settings and the chat view are mutually exclusive (no risk of it going stale while both are visible). */
  async function loadDiagnostics(): Promise<void> {
    const assistant = assistantRef.current
    if (!assistant) return
    const [summary, transcript, checks] = await Promise.all([
      assistant.getMemorySummary(sessionIdRef.current),
      assistant.getTranscript(sessionIdRef.current),
      runHealthChecks(),
    ])
    setMemorySummary(summary)
    setTranscriptLength(transcript.length)
    setHealthChecks(checks)
  }

  async function handleOpenSettings(): Promise<void> {
    setView('settings')
    void loadDiagnostics()
  }

  /** GUI equivalent of /clear — ends the conversation and resets every piece of derived UI state alongside it, so nothing shows stale data for the fresh session. */
  async function handleClearConversation(): Promise<void> {
    const assistant = assistantRef.current
    if (!assistant) return
    await assistant.clearSession(sessionIdRef.current)
    setEntries([])
    setLastTurnUsage(undefined)
    setSessionUsage(undefined)
    setMemorySummary(null)
    setHealthChecks(null)
    setTranscriptLength(0)
    setActivePlanStatus(undefined)
  }

  /** GUI equivalent of /export — downloads the transcript as a markdown file via a throwaway Blob URL (works the same in a plain browser tab and inside the Tauri webview, so desktop doesn't need a separate native-save-dialog path). */
  async function handleExportTranscript(): Promise<void> {
    const assistant = assistantRef.current
    if (!assistant) return
    const transcript = await assistant.getTranscript(sessionIdRef.current)
    if (transcript.length === 0) return
    const blob = new Blob([formatTranscriptMarkdown(transcript)], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = defaultExportFilename()
    a.click()
    URL.revokeObjectURL(url)
  }

  /**
   * GUI equivalent of /undo — peeks the transcript before calling undoLastTurn to know which
   * UI entries correspond to what just got removed (mirrors cli.ts's handleUndo): a completed
   * turn's last 'assistant' entry and the 'user' entry immediately before it, or — if the turn
   * was still awaiting approval — just the last 'approval' entry (no reply was ever appended).
   */
  async function handleUndoLastTurn(): Promise<void> {
    const assistant = assistantRef.current
    if (!assistant) return
    const transcriptBefore = await assistant.getTranscript(sessionIdRef.current)
    if (transcriptBefore.length === 0) return
    const wasPendingApproval = transcriptBefore[transcriptBefore.length - 1].role !== 'assistant'

    const result = await assistant.undoLastTurn(sessionIdRef.current)
    if (!result.undone) return

    setEntries((prev) => {
      const kinds = prev.map((e) => e.kind)
      if (wasPendingApproval) {
        const approvalIdx = kinds.lastIndexOf('approval')
        return approvalIdx === -1 ? prev : prev.filter((_, i) => i !== approvalIdx)
      }
      const assistantIdx = kinds.lastIndexOf('assistant')
      if (assistantIdx === -1) return prev
      let userIdx = assistantIdx - 1
      while (userIdx >= 0 && kinds[userIdx] !== 'user') userIdx--
      return prev.filter((_, i) => i !== assistantIdx && i !== userIdx)
    })
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const store = await createConfigStore()
      const persisted = await store.load()
      const resolved = resolveConfig(persisted, envOverrides)
      if (cancelled) return
      configStoreRef.current = store
      setConfig(resolved.config)
      setOverriddenKeys(resolved.overriddenKeys)
      const assistant = await buildAssistant(resolved.config)
      if (!cancelled) assistantRef.current = assistant
    })()
    return () => { cancelled = true }
  }, [])

  async function handleSaveSettings(patch: Partial<AssistantConfig>): Promise<void> {
    const store = configStoreRef.current
    if (!store) return
    await store.save(patch)
    const persisted = await store.load()
    const resolved = resolveConfig(persisted, envOverrides)
    setConfig(resolved.config)
    setOverriddenKeys(resolved.overriddenKeys)
    assistantRef.current = await buildAssistant(resolved.config)
    setView('chat')
  }

  async function handlePickWorkspaceDirectory(): Promise<string | null> {
    return invoke<string | null>('pick_workspace_directory')
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [entries])

  async function runTurn(message: string, approved: boolean): Promise<void> {
    const assistant = assistantRef.current
    if (!assistant) {
      setEntries((prev) => [
        ...prev,
        { id: newId(), kind: 'error', content: 'Assistant is still starting up — try again in a moment.', retryable: true, retryMessage: message, retryApproved: approved },
      ])
      return
    }

    setBusy(true)
    setProgress(null)
    setStreamingText(null)
    setLiveToolSteps([])
    const toolSteps: AssistantToolStep[] = []
    try {
      const result = await assistant.turn(message, {
        sessionId: sessionIdRef.current,
        approved,
        onProgress: setProgress,
        onToken: (token) => setStreamingText((prev) => (prev ?? '') + token),
        onToolStep: (step) => {
          toolSteps.push(step)
          setLiveToolSteps((prev) => [...prev, step])
        },
      })

      if (result.status === 'ok') {
        setEntries((prev) => [
          ...prev,
          {
            id: newId(),
            kind: 'assistant',
            content: result.reply ?? '',
            riskLevel: result.riskLevel,
            trace: result.trace,
            harnessSkipped: result.harnessSkipped,
            sources: result.sources,
            toolSteps: toolSteps.length > 0 ? toolSteps : undefined,
            planStatus: result.planStatus,
          },
        ])
        setActivePlanStatus(result.planStatus)
        if (result.usage) {
          const withCost = withCostEstimate(result.usage)
          setLastTurnUsage(withCost)
          setSessionUsage((prev) => accumulateUsage(prev, withCost))
        } else {
          setLastTurnUsage(undefined)
        }
      } else if (result.status === 'needs_approval') {
        setEntries((prev) => [
          ...prev,
          { id: newId(), kind: 'approval', pendingMessage: message, reason: result.reason ?? 'This action needs approval.', riskLevel: result.riskLevel },
        ])
      } else {
        setEntries((prev) => [...prev, { id: newId(), kind: 'escalation', reason: result.reason ?? 'The assistant halted and needs more information.' }])
      }
    } catch (err) {
      // classifyError maps to friendly copy for the UI, which is often too coarse to debug
      // from — the raw error (and on desktop, invoke() rejections carry only a string with
      // no code/name) is otherwise never surfaced anywhere, not even devtools. Log it.
      console.error('[assistant turn failed]', err)
      const { message: errorMessage, retryable } = classifyError(err)
      setEntries((prev) => [...prev, { id: newId(), kind: 'error', content: errorMessage, retryable, retryMessage: message, retryApproved: approved }])
    } finally {
      setBusy(false)
      setProgress(null)
      setStreamingText(null)
      setLiveToolSteps([])
    }
  }

  function submitMessage(): void {
    const message = input.trim()
    if (!message || busy) return
    setInput('')
    // The composer's height was grown by handleComposerInput as the user typed multiple
    // lines — reset it here rather than waiting for the now-empty value to reflow next paint.
    if (composerRef.current) composerRef.current.style.height = 'auto'
    setEntries((prev) => [...prev, { id: newId(), kind: 'user', content: message }])
    void runTurn(message, false)
  }

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault()
    submitMessage()
  }

  /** Enter submits (matching the old single-line <input>'s behavior); Shift+Enter inserts a real newline, which a plain <input> can never hold — see the <textarea> below. */
  function handleComposerKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submitMessage()
    }
  }

  /** Auto-grows the composer with content (capped by CSS max-height, which then scrolls) instead of hiding wrapped/newline text in a fixed-height box. */
  function handleComposerInput(e: React.ChangeEvent<HTMLTextAreaElement>): void {
    setInput(e.target.value)
    e.target.style.height = 'auto'
    e.target.style.height = `${e.target.scrollHeight}px`
  }

  function handleApprove(entryId: string, pendingMessage: string): void {
    setEntries((prev) => prev.map((e) => (e.id === entryId && e.kind === 'approval' ? { ...e, resolution: 'approved' } : e)))
    void runTurn(pendingMessage, true)
  }

  function handleDeny(entryId: string): void {
    setEntries((prev) => prev.map((e) => (e.id === entryId && e.kind === 'approval' ? { ...e, resolution: 'denied' } : e)))
  }

  function handleRetry(message: string, approved: boolean): void {
    void runTurn(message, approved)
  }

  if (view === 'settings') {
    return (
      <SettingsScreen
        config={config}
        overriddenKeys={overriddenKeys}
        isDesktop={isTauri()}
        busy={busy}
        onSave={handleSaveSettings}
        onCancel={() => setView('chat')}
        onPickWorkspaceDirectory={isTauri() ? handlePickWorkspaceDirectory : undefined}
        transcriptLength={transcriptLength}
        memorySummary={memorySummary}
        lastTurnUsage={lastTurnUsage}
        sessionUsage={sessionUsage}
        healthChecks={healthChecks}
      />
    )
  }

  return (
    <div className="app">
      <header className="app__header">
        <span className="app__header-title">Assistant</span>
        <div className="app__header-actions">
          <button type="button" aria-label="New chat" title="New chat" disabled={busy} onClick={() => void handleClearConversation()}>New chat</button>
          <button type="button" aria-label="Export transcript" title="Export transcript" disabled={busy || entries.length === 0} onClick={() => void handleExportTranscript()}>Export</button>
          <button type="button" aria-label="Undo last exchange" title="Undo last exchange" disabled={busy || entries.length === 0} onClick={() => void handleUndoLastTurn()}>Undo</button>
          <button type="button" className="app__settings-button" aria-label="Settings" onClick={() => void handleOpenSettings()}>⚙</button>
        </div>
      </header>
      <div className="app__messages">
        {entries.map((entry) => {
          switch (entry.kind) {
            case 'user':
              return <ChatMessageBubble key={entry.id} role="user" content={entry.content} />
            case 'assistant':
              return (
                <ChatMessageBubble
                  key={entry.id}
                  role="assistant"
                  content={entry.content}
                  riskLevel={entry.riskLevel}
                  trace={entry.trace}
                  harnessSkipped={entry.harnessSkipped}
                  sources={entry.sources}
                  toolSteps={entry.toolSteps}
                  planStatus={entry.planStatus}
                />
              )
            case 'error':
              return (
                <ChatMessageBubble
                  key={entry.id}
                  role="error"
                  content={entry.content}
                  onRetry={entry.retryable ? () => handleRetry(entry.retryMessage, entry.retryApproved) : undefined}
                />
              )
            case 'approval':
              return (
                <ApprovalCard
                  key={entry.id}
                  pendingMessage={entry.pendingMessage}
                  reason={entry.reason}
                  riskLevel={entry.riskLevel}
                  resolution={entry.resolution}
                  onApprove={() => handleApprove(entry.id, entry.pendingMessage)}
                  onDeny={() => handleDeny(entry.id)}
                />
              )
            case 'escalation':
              return <EscalationBanner key={entry.id} reason={entry.reason} />
          }
        })}
        {busy && streamingText && <ChatMessageBubble role="assistant" content={streamingText} />}
        {busy && (!streamingText || progress) && (
          <div className="app__typing">
            {progress
              ? progress.planPosition
                // Phase 3.2: a plan-driven turn shows live position instead of the generic
                // step counter for the duration of the run — harness-internal node detail is
                // still available via the "Why?" panel once the turn finishes.
                ? `${progress.planPosition.templateName} — step ${progress.planPosition.stepIndex} of ${progress.planPosition.stepCount} (${progress.planPosition.completionPct.toFixed(0)}%)${progress.currentNode ? ` — ${nodeDisplayName(progress.currentNode)}…` : ''}`
                : `Step ${progress.stepsUsed} of ${progress.maxSteps}${progress.currentNode ? ` — ${nodeDisplayName(progress.currentNode)}…` : ''}`
              : 'thinking…'}
          </div>
        )}
        {busy && liveToolSteps.length > 0 && (
          <div className="app__tool-steps">
            {liveToolSteps.map((step, i) => (
              <div key={i} className="app__tool-step">⚙ {step.summary}</div>
            ))}
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      {/* Phase 3.2: persistent, visible only while a durable plan is actually active — chat-ui
          had zero plan awareness before this (closes a total gap, not an enhancement). */}
      {activePlanStatus && (
        <div className="app__plan-strip">
          Following plan: {activePlanStatus.templateName} — step{' '}
          {activePlanStatus.tasks.filter((t) => t.status === 'COMPLETE').length + 1} of {activePlanStatus.tasks.length}{' '}
          ({activePlanStatus.completionPct.toFixed(0)}%)
        </div>
      )}
      <form className="app__composer" onSubmit={handleSubmit}>
        <textarea
          ref={composerRef}
          value={input}
          onChange={handleComposerInput}
          onKeyDown={handleComposerKeyDown}
          placeholder="Message the assistant…"
          rows={1}
          disabled={busy}
        />
        <button type="submit" disabled={busy || !input.trim()}>Send</button>
      </form>
    </div>
  )
}
