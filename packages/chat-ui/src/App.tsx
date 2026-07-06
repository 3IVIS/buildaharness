import { useEffect, useRef, useState } from 'react'
import { isTauri, invoke } from '@tauri-apps/api/core'
import {
  PersonalAssistant,
  nodeDisplayName,
  classifyError,
  resolveConfig,
  type AssistantProgress,
  type AssistantToolStep,
  type AssistantConfig,
  type ConfigStore,
} from '@buildaharness/personal-assistant'
import { LLMClient, FileSystemAdapter, FileSystemExperienceStore } from '@buildaharness/runtime'
import { TauriClaudeCliLLMClient } from './tauri-claude-cli-llm-client'
import { ChatMessageBubble } from './components/ChatMessageBubble'
import { ApprovalCard } from './components/ApprovalCard'
import { EscalationBanner } from './components/EscalationBanner'
import { SettingsScreen } from './components/SettingsScreen'
import { BrowserConfigStore } from './browser-config-store'
import { TauriConfigStore } from './tauri-config-store'
import { envOverridesFromImportMetaEnv } from './browser-config'
import type { ChatEntry } from './types'

// Env/build-time vars still win over persisted config — see browser-config.ts and
// config.ts's resolveConfig — so nothing changes for a deployed build that already sets
// VITE_ASSISTANT_PROXY_URL/_TOKEN/_MODEL and never opens Settings.
const envOverrides = envOverridesFromImportMetaEnv(import.meta.env)

function newId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
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
 * PersonalAssistant.create() only defaults storage that isn't already supplied
 * (browser → Dexie), so passing filesystem-backed stores here is what gives the
 * desktop build real persistence instead of the IndexedDB it'd otherwise pick.
 * @tauri-apps/plugin-fs is dynamically imported so a plain (non-Tauri) browser
 * build never has to load it. See plans/tauri_desktop_plan.html Phase 3.
 *
 * Uses TauriClaudeCliLLMClient (the desktop shell's `run_claude_prompt`/
 * `run_claude_prompt_with_file_tools` Rust commands), not the LLMClient/proxy backend the
 * plain browser build uses below — the desktop app has no LLM proxy running by default
 * and no ANTHROPIC_API_KEY to stand one up with, so it runs against the user's
 * already-authenticated Claude Code CLI session instead, the same way personal-assistant's
 * own CLI front end does with ASSISTANT_LLM_BACKEND=claude-cli.
 *
 * fileTools is wired to `config.workspaceRoot` if the user has picked one via the Settings
 * screen's Workspace section, falling back to `get_dev_workspace_root()` (the monorepo root,
 * computed on the Rust side from this crate's compile-time location — see that command's own
 * doc comment) otherwise. Note: `config.enableWeb`/`enableShell`/`searchBackend` are
 * persisted and shown in Settings for schema consistency with the CLI, but chat-ui has no
 * web_search/fetch_url/run_shell_command wiring of its own yet — those toggles don't change
 * behavior here until that capability is added, the same pre-existing gap this doc comment
 * already noted before Settings existed.
 */
async function createTauriBackedAssistant(config: AssistantConfig): Promise<PersonalAssistant> {
  const [{ appLocalDataDir }, { createTauriFsBackend }] = await Promise.all([
    import('@tauri-apps/api/path'),
    import('./tauri-fs-backend'),
  ])
  const baseDir = await appLocalDataDir()
  const backend = createTauriFsBackend()
  const workspaceRoot = config.workspaceRoot ?? (await invoke<string>('get_dev_workspace_root'))

  return PersonalAssistant.create({
    llmClient: new TauriClaudeCliLLMClient({ fileTools: true }),
    model: config.model,
    memory: new FileSystemAdapter({ backend, baseDir, namespace: 'transcripts' }),
    experienceStore: await FileSystemExperienceStore.create({ backend, baseDir, namespace: 'experience' }),
    checkpointStore: new FileSystemAdapter({ backend, baseDir, namespace: 'checkpoints' }),
    fileTools: { backend, workspaceRoot },
  })
}

async function buildAssistant(config: AssistantConfig): Promise<PersonalAssistant> {
  if (isTauri()) return createTauriBackedAssistant(config)
  return PersonalAssistant.create({ llmClient: new LLMClient({ proxyUrl: config.proxyUrl, authToken: config.authToken }), model: config.model })
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
  const assistantRef = useRef<PersonalAssistant | null>(null)
  const configStoreRef = useRef<ConfigStore | null>(null)
  const sessionIdRef = useRef(newId())
  const bottomRef = useRef<HTMLDivElement>(null)

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
            sources: result.sources,
            toolSteps: toolSteps.length > 0 ? toolSteps : undefined,
          },
        ])
      } else if (result.status === 'needs_approval') {
        setEntries((prev) => [
          ...prev,
          { id: newId(), kind: 'approval', pendingMessage: message, reason: result.reason ?? 'This action needs approval.', riskLevel: result.riskLevel },
        ])
      } else {
        setEntries((prev) => [...prev, { id: newId(), kind: 'escalation', reason: result.reason ?? 'The assistant halted and needs more information.' }])
      }
    } catch (err) {
      const { message: errorMessage, retryable } = classifyError(err)
      setEntries((prev) => [...prev, { id: newId(), kind: 'error', content: errorMessage, retryable, retryMessage: message, retryApproved: approved }])
    } finally {
      setBusy(false)
      setProgress(null)
      setStreamingText(null)
      setLiveToolSteps([])
    }
  }

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault()
    const message = input.trim()
    if (!message || busy) return
    setInput('')
    setEntries((prev) => [...prev, { id: newId(), kind: 'user', content: message }])
    void runTurn(message, false)
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
      />
    )
  }

  return (
    <div className="app">
      <header className="app__header">
        <span className="app__header-title">Assistant</span>
        <button type="button" className="app__settings-button" aria-label="Settings" onClick={() => setView('settings')}>⚙</button>
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
                  sources={entry.sources}
                  toolSteps={entry.toolSteps}
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
              ? `Step ${progress.stepsUsed} of ${progress.maxSteps}${progress.currentNode ? ` — ${nodeDisplayName(progress.currentNode)}…` : ''}`
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
      <form className="app__composer" onSubmit={handleSubmit}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Message the assistant…"
          disabled={busy}
        />
        <button type="submit" disabled={busy || !input.trim()}>Send</button>
      </form>
    </div>
  )
}
