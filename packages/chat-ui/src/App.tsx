import { useEffect, useRef, useState } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import { PersonalAssistant, nodeDisplayName, classifyError, type AssistantProgress } from '@buildaharness/personal-assistant'
import { LLMClient, FileSystemAdapter, FileSystemExperienceStore } from '@buildaharness/runtime'
import { ChatMessageBubble } from './components/ChatMessageBubble'
import { ApprovalCard } from './components/ApprovalCard'
import { EscalationBanner } from './components/EscalationBanner'
import type { ChatEntry } from './types'

const proxyUrl = import.meta.env.VITE_ASSISTANT_PROXY_URL ?? 'http://localhost:8787'
const authToken = import.meta.env.VITE_ASSISTANT_PROXY_TOKEN ?? ''
const model = import.meta.env.VITE_ASSISTANT_MODEL || undefined

function newId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
}

/**
 * PersonalAssistant.create() only defaults storage that isn't already supplied
 * (browser → Dexie), so passing filesystem-backed stores here is what gives the
 * desktop build real persistence instead of the IndexedDB it'd otherwise pick.
 * @tauri-apps/plugin-fs is dynamically imported so a plain (non-Tauri) browser
 * build never has to load it. See plans/tauri_desktop_plan.html Phase 3.
 */
async function createTauriBackedAssistant(): Promise<PersonalAssistant> {
  const [{ appLocalDataDir }, { createTauriFsBackend }] = await Promise.all([
    import('@tauri-apps/api/path'),
    import('./tauri-fs-backend'),
  ])
  const baseDir = await appLocalDataDir()
  const backend = createTauriFsBackend()

  return PersonalAssistant.create({
    llmClient: new LLMClient({ proxyUrl, authToken }),
    model,
    memory: new FileSystemAdapter({ backend, baseDir, namespace: 'transcripts' }),
    experienceStore: await FileSystemExperienceStore.create({ backend, baseDir, namespace: 'experience' }),
    checkpointStore: new FileSystemAdapter({ backend, baseDir, namespace: 'checkpoints' }),
  })
}

export function App(): React.JSX.Element {
  const [entries, setEntries] = useState<ChatEntry[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<AssistantProgress | null>(null)
  const [streamingText, setStreamingText] = useState<string | null>(null)
  const assistantRef = useRef<PersonalAssistant | null>(null)
  const sessionIdRef = useRef(newId())
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    const create = isTauri() ? createTauriBackedAssistant() : PersonalAssistant.create({ llmClient: new LLMClient({ proxyUrl, authToken }), model })
    void create.then((assistant) => {
      if (!cancelled) assistantRef.current = assistant
    })
    return () => { cancelled = true }
  }, [])

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
    try {
      const result = await assistant.turn(message, {
        sessionId: sessionIdRef.current,
        approved,
        onProgress: setProgress,
        onToken: (token) => setStreamingText((prev) => (prev ?? '') + token),
      })

      if (result.status === 'ok') {
        setEntries((prev) => [
          ...prev,
          { id: newId(), kind: 'assistant', content: result.reply ?? '', riskLevel: result.riskLevel, trace: result.trace, sources: result.sources },
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

  return (
    <div className="app">
      <header className="app__header">Assistant</header>
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
