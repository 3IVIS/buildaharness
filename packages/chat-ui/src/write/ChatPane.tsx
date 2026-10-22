import { AdjustBar, type ChatAction } from './AdjustBar'
import { ModelPicker } from './ModelPicker'
import { useEffect, useState } from 'react'
import { checklistAt, elapsedText, stageSentence, workPlan, type WorkKind } from '@buildaharness/aielia'
import { ICON_PATHS, Icon, IconButton } from './icons'

/** A background model call as the chat shows it: its kind (which checklist), the stage it is at, and a finer step inside the stage. */
export interface WorkProgress { kind: WorkKind; label: string; stage: number; detail?: string; startedAt: number }

export type ChatMode = 'answer' | 'suggest' | 'edit'

export interface ChatLine {
  id: number
  from: 'you' | 'aielia'
  text: string
  model?: string
  /** What the request that ended with this line used: tokens, time and cost, in small type. */
  usage?: string
}

interface Props {
  lines: ChatLine[]
  model: string
  suggestions: string[]
  onModel: (model: string) => void
  input: string
  onInput: (value: string) => void
  /** What a request for a change does: only answers, suggests changes to accept, or makes the edit (after saving a version). */
  mode: ChatMode
  onMode: (mode: ChatMode) => void
  /** What "edit" edits where the writer is now: the article, or its outline. */
  editLabel: string
  busy: boolean
  /** What a command sent through the chat is doing now; shown as the last line until the result or the error replaces it. */
  progress?: WorkProgress | null
  canAct: boolean
  shown: boolean
  onSend: () => void
  onAdjust: (message: string) => void
  onAction: (action: ChatAction) => void
  /** Repositories handed to the open article, and what the chat menu does with them: run the check against a typed address or the attached ones. */
  repos: string[]
  onRepoVerify: (address: string) => void
  onPickRepoFolder?: () => void
  onRemoveRepo: (name: string) => void
  onDropFiles: (files: File[]) => void
  /** Closes the chat sheet on a phone. */
  onClose: () => void
}

/** The chat: always visible on a wide screen. The model is picked next to the title; every answer says which model wrote it. */
export function ChatPane(p: Props): React.JSX.Element {
  return (
    <section
      className={`write__pane write__pane--chat ${p.shown ? 'is-shown' : ''}`}
      aria-label="Chat"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); const files = Array.from(e.dataTransfer.files); if (files.length > 0) p.onDropFiles(files) }}
    >
      <header className="write__chathead">
        <h2 className="write__panehead">Chat</h2>
        <ModelPicker label="Model for the chat" value={p.model} suggestions={p.suggestions} onChange={p.onModel} />
        <IconButton label="Close the chat" icon="close" className="write__chatclose" onClick={p.onClose} />
      </header>
      <ul className="write__chat" aria-live="polite">
        {p.lines.map((l) => (
          <li key={l.id} className={`write__line write__line--${l.from}`}>
            <div>{l.text}</div>
            {l.usage && <div className="write__lineusage" title="Tokens, time and cost of this request">{l.usage}</div>}
            {l.from === 'aielia' && l.model && (
              <div className="write__linemeta">
                <span className="write__linemodel" title="The model that wrote this">{l.model}</span>
              </div>
            )}
          </li>
        ))}
        {p.progress && <WorkTicker progress={p.progress} />}
        {p.lines.length === 0 && !p.progress && <li className="write__muted">Talk to Aielia about the article, paste reviewer comments, or drop a file here to use it as a source.</li>}
      </ul>
      <AdjustBar disabled={p.busy || !p.canAct} checkLabel="Find the factual claims and check them against their sources" verifyLabel="Search the web for sources and verify the claims" repos={p.repos} onRepoVerify={p.onRepoVerify} onPickRepoFolder={p.onPickRepoFolder} onRemoveRepo={p.onRemoveRepo} onSend={p.onAdjust} onAction={p.onAction} />
      <div className={`write__compose${p.progress ? ' is-working' : ''}`}>
        <textarea
          aria-label="Message"
          value={p.input}
          rows={3}
          onChange={(e) => p.onInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!p.busy && p.input.trim()) p.onSend() } }}
          placeholder="Message Aielia. Enter sends, Shift+Enter starts a new line."
        />
        <div className="write__composebar">
          <label className="write__switch2" title="What happens when you ask for a change to the text. Editing saves a version first, so it can be undone from History.">
            <select aria-label="When I ask for a change" value={p.mode} onChange={(e) => p.onMode(e.target.value as ChatMode)}>
              <option value="answer">Just answer</option>
              <option value="suggest">Suggest edits</option>
              <option value="edit">{p.editLabel}</option>
            </select>
          </label>
          <button type="button" className={`write__iconbtn write__send${p.progress ? ' is-working' : ''}`} aria-label="Send" title="Send" onClick={p.onSend} disabled={p.busy || !p.input.trim()}><Icon d={ICON_PATHS.write} /></button>
        </div>
      </div>
    </section>
  )
}

/**
 * What Aielia is doing while a model call runs: a pulse, the stage in a sentence that fades into the next one, the finer step under it,
 * the checklist for the kind of job, and a running time once it has gone on a few seconds. It is the last line of the chat and is gone
 * when the answer arrives, so only the result stays.
 */
function WorkTicker({ progress }: { progress: WorkProgress }): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const plan = workPlan(progress.kind, progress.label)
  const items = checklistAt(plan, progress.stage)
  const sentence = stageSentence(plan, progress.stage) ?? `${progress.label}…`
  const elapsed = elapsedText(now - progress.startedAt)
  return (
    <li className="write__line write__line--aielia write__line--progress write__work" role="status">
      <div className="write__worklabel">{progress.label}</div>
      <div className="write__workhead">
        <span className="write__pulse" aria-hidden="true"><i /><i /><i /></span>
        <span key={sentence} className="write__worksentence">{sentence}</span>
        {elapsed && <span className="write__workelapsed" title="How long this has been running">{elapsed}</span>}
      </div>
      {progress.detail && <div className="write__workdetail" key={progress.detail}>{progress.detail}</div>}
      {items.length > 1 && (
        <ol className="write__checklist" aria-label="Steps">
          {items.map((it) => <li key={it.text} className={`is-${it.state}`}><span className="write__tick" aria-hidden="true">{it.state === 'done' ? '✓' : ''}</span>{it.text}</li>)}
        </ol>
      )}
    </li>
  )
}
