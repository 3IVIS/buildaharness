import { AdjustBar, type ChatAction } from './AdjustBar'
import { ModelPicker } from './ModelPicker'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CLI_DEFAULT_LABEL, modelLabel, checklistAt, elapsedText, stageSentence, workPlan, type WorkKind, type ResultLine } from '@buildaharness/aielia'
import { ICON_PATHS, Icon, IconButton } from './icons'

/** A background model call as the chat shows it: its kind (which checklist), the stage it is at, and a finer step inside the stage. */
export interface WorkProgress {
  kind: WorkKind
  label: string
  stage: number
  detail?: string
  startedAt: number
  /** How far through a counted job (claims checked, categories worked through). */
  count?: readonly [number, number]
  /** How long this kind of job usually takes, as a sentence ("Usually about 20 s"), from the writer's own earlier runs. */
  usually?: string
  /** The newest finished pieces of a counted job (claims checked so far), with how each came out. */
  results?: readonly ResultLine[]
  /** The words of a plain answer so far, while it is being written. */
  streamed?: string
  /** Stop was pressed; the job ends at its next step. */
  stopping?: boolean
  /** The job is over and the last step is shown ticked for a moment before it goes. */
  finishing?: boolean
}

export type ChatMode = 'answer' | 'suggest' | 'edit'

/** What hovering a record line says. */
export const RECORD_HINT = 'A record of an action in the interface, not a chat message'

export interface ChatLine {
  id: number
  from: 'you' | 'aielia'
  text: string
  model?: string
  /** What the request that ended with this line used: tokens, time and cost, in small type. */
  usage?: string
  /** The line records an action taken in the interface (a button, a drop, a setting), not something said in the chat; it is drawn quieter and says so on hover. */
  record?: boolean
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
  /** Stops the job that is running, at its next step. */
  onStop?: () => void
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
  // The chat follows new lines and the working block while the writer is at the bottom; a writer who has scrolled up to read is left alone,
  // unless they have just sent a message.
  const list = useRef<HTMLUListElement | null>(null)
  const atBottom = useRef(true)
  const lastFrom = p.lines.at(-1)?.from
  const working = Boolean(p.progress)
  const { stage, detail, streamed, finishing } = p.progress ?? {}
  useLayoutEffect(() => {
    const el = list.current
    if (el && (atBottom.current || lastFrom === 'you')) { el.scrollTop = el.scrollHeight; atBottom.current = true }
  }, [p.lines.length, lastFrom, working, stage, detail, streamed, finishing])
  return (
    <section
      className={`write__pane write__pane--chat ${p.shown ? 'is-shown' : ''}`}
      aria-label="Chat"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); const files = Array.from(e.dataTransfer.files); if (files.length > 0) p.onDropFiles(files) }}
    >
      <header className="write__chathead">
        <h2 className="write__panehead">Chat</h2>
        <ModelPicker label="Model for the chat" value={p.model} suggestions={p.suggestions} onChange={p.onModel} placeholder={CLI_DEFAULT_LABEL} />
        <IconButton label="Close the chat" icon="close" className="write__chatclose" onClick={p.onClose} />
      </header>
      <ul className="write__chat" aria-live="polite" ref={list} onScroll={(e) => { const el = e.currentTarget; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60 }}>
        {p.lines.map((l) => (
          <li key={l.id} className={`write__line write__line--${l.from}${l.record ? ' write__line--record' : ''}`} title={l.record ? RECORD_HINT : undefined}>
            <div>{l.text}</div>
            {l.usage && <div className="write__lineusage" title="Tokens, time and cost of this request">{l.usage}</div>}
            {l.from === 'aielia' && l.model !== undefined && (
              <div className="write__linemeta">
                <span className="write__linemodel" title="The model that wrote this">{modelLabel(l.model)}</span>
              </div>
            )}
          </li>
        ))}
        {p.progress && <WorkTicker progress={p.progress} onStop={p.onStop} />}
        {p.lines.length === 0 && !p.progress && <li className="write__muted">Talk to Aielia about the article, paste reviewer comments, or drop a file here to use it as a source.</li>}
      </ul>
      <AdjustBar disabled={p.busy || !p.canAct} checkLabel="Find the factual claims and check them against their sources" verifyLabel="Search the web for sources and verify the claims" repos={p.repos} onRepoVerify={p.onRepoVerify} onPickRepoFolder={p.onPickRepoFolder} onRemoveRepo={p.onRemoveRepo} onSend={p.onAdjust} onAction={p.onAction} />
      <div className={`write__compose${p.progress && !p.progress.finishing ? ' is-working' : ''}`}>
        <textarea
          aria-label="Message"
          value={p.input}
          rows={3}
          onChange={(e) => p.onInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape' && p.progress && !p.progress.finishing) { e.preventDefault(); p.onStop?.() } else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!p.busy && p.input.trim()) p.onSend() } }}
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
          <button type="button" className={`write__iconbtn write__send${p.progress && !p.progress.finishing ? ' is-working' : ''}`} aria-label="Send" title="Send" onClick={p.onSend} disabled={p.busy || !p.input.trim()}><Icon d={ICON_PATHS.write} /></button>
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
function WorkTicker({ progress, onStop }: { progress: WorkProgress; onStop?: () => void }): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const plan = workPlan(progress.kind, progress.label)
  const items = checklistAt(plan, progress.finishing ? plan.steps.length : progress.stage)
  const sentence = progress.finishing ? 'Done.' : progress.stopping ? 'Stopping after this step…' : stageSentence(plan, progress.stage) ?? `${progress.label}…`
  const elapsed = progress.finishing ? undefined : elapsedText(now - progress.startedAt)
  const long = !progress.finishing && !progress.stopping && now - progress.startedAt > 20000 && progress.streamed === undefined
  const [done, total] = progress.count ?? [0, 0]
  return (
    <li className={`write__line write__line--aielia write__line--progress write__work${progress.finishing ? ' is-finishing' : ''}`} role="status">
      <div className="write__worklabel">{progress.label}</div>
      <div className="write__workhead">
        <span className="write__pulse" aria-hidden="true"><i /><i /><i /></span>
        <span key={sentence} className="write__worksentence">{sentence}</span>
        {elapsed && <span className="write__workelapsed" aria-hidden="true" title="How long this has been running">{elapsed}</span>}
        {onStop && !progress.finishing && !progress.stopping && <button type="button" className="write__stop" title="Stop after the step it is on (Esc)" onClick={onStop}>Stop</button>}
      </div>
      {progress.detail && <div className="write__workdetail" key={progress.detail}>{progress.detail}</div>}
      {progress.usually && !progress.finishing && <div className="write__workdetail">{progress.usually}</div>}
      {total > 0 && (
        <div className="write__count">
          <div className="write__countbar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}><div style={{ width: `${Math.min(100, (done / total) * 100)}%` }} /></div>
          <span>{done} of {total} done</span>
        </div>
      )}
      {progress.results && progress.results.length > 0 && (
        <ul className="write__results" aria-label="Checked so far">
          {progress.results.map((r, i) => <li key={`${i}-${r.text}`} className={`is-${r.tone}`}>{r.text}</li>)}
        </ul>
      )}
      {items.length > 1 && (
        <ol className="write__checklist" aria-label="Steps">
          {items.map((it) => <li key={it.text} className={`is-${it.state}`}><span className="write__tick" aria-hidden="true">{it.state === 'done' ? '✓' : ''}</span>{it.text}</li>)}
        </ol>
      )}
      {progress.streamed && <div className="write__stream" aria-hidden="true">{progress.streamed}</div>}
      {long && <div className="write__workdetail">This one takes a while. You can keep reading the article.</div>}
    </li>
  )
}
