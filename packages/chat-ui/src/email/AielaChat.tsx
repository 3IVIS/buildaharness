import { useEffect, useLayoutEffect, useRef } from 'react'
import type { WorkbenchEvent } from '@buildaharness/aielia'
import { MailIcon } from './mail-ui'
import { ActivityLog } from './WorkbenchResults'

export interface AielaChatLine {
  id: number
  from: 'you' | 'aielia'
  text: string
  /** A richer answer (a list with links, say) drawn instead of the text. The text stays as the plain version. */
  node?: React.ReactNode
}

/** The tasks Aielia can be asked to do from the dropdown beside Send, grouped as the dropdown shows them. */
export interface TaskMenu {
  groups: ReadonlyArray<{ label: string; options: ReadonlyArray<{ value: string; label: string }> }>
  onPick: (value: string) => void
}

interface Props {
  lines: readonly AielaChatLine[]
  input: string
  onInput: (v: string) => void
  onSend: (text?: string) => void
  busy?: boolean
  /** Things worth asking, shown while the chat is empty; a click sends one. */
  suggestions?: readonly string[]
  /** A short line under the name ("Sample mailbox"). */
  subtitle?: string
  /** Replaces the empty-state sentence. */
  emptyText?: string
  /** The task dropdown in the compose bar (the same place as Write's mode box). Choosing a task runs it. */
  tasks?: TaskMenu
  /** What Aielia is doing now (a short phrase), shown in the chat while a task runs. */
  working?: string
  /** Every model and tool call so far, in a fold-out under the chat. */
  activity?: readonly WorkbenchEvent[]
}

/** The Aielia column of the Email page, drawn with the same chat look as Write: a header, the lines, the empty state with things to ask, and the composer. */
export function AielaChat(p: Props): React.JSX.Element {
  const list = useRef<HTMLUListElement | null>(null)
  const atBottom = useRef(true)
  useLayoutEffect(() => {
    const el = list.current
    if (el && atBottom.current) el.scrollTop = el.scrollHeight
  }, [p.lines.length])
  const box = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    // A hidden panel (the phone's other tabs) measures 0, so the box never goes below one line.
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 36), 160)}px`
  }, [p.input])
  return (
    <section className="achat" aria-label="Aielia">
      <header className="achat__head">
        <span className="achat__logo" aria-hidden="true"><MailIcon name="sparkle" size={16} /></span>
        <div className="achat__who">
          <h2>Aielia</h2>
          {p.subtitle && <p>{p.subtitle}</p>}
        </div>
      </header>
      <ul
        className="achat__lines" aria-live="polite" ref={list}
        onScroll={(e) => { const el = e.currentTarget; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60 }}
      >
        {p.lines.map((l) => <li key={l.id} className={`achat__line achat__line--${l.from}${l.node ? ' achat__line--rich' : ''}`} data-from={l.from}>{l.node ?? l.text}</li>)}
        {p.working && <li className="achat__line achat__line--aielia achat__line--working" role="status">Aielia is working: {p.working}…</li>}
        {p.lines.length === 0 && !p.working && (
          <li className="achat__empty">
            <span className="achat__emptyicon" aria-hidden="true"><MailIcon name="sparkle" size={22} /></span>
            <p>{p.emptyText ?? 'Ask about your mail, or have Aielia sort and draft for you.'}</p>
            {p.suggestions && p.suggestions.length > 0 && (
              <ul className="achat__chips" aria-label="Things to ask">
                {p.suggestions.map((s) => <li key={s}><button type="button" onClick={() => p.onSend(s)} disabled={p.busy}>{s}</button></li>)}
              </ul>
            )}
          </li>
        )}
      </ul>
      {p.activity && <ActivityLog events={p.activity} working={!!p.working} />}
      <div className="achat__compose">
        <textarea
          ref={box}
          aria-label="Ask Aielia"
          rows={1}
          value={p.input}
          placeholder="Ask Aielia about your mail"
          onChange={(e) => p.onInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!p.busy && p.input.trim()) p.onSend() } }}
        />
        <div className="achat__bar">
          {p.tasks && (
            <label className="achat__task" title="Ask Aielia to do something with this mailbox. Everything here reads: nothing is moved, saved to Mail or sent.">
              <select
                aria-label="Aielia task"
                value=""
                disabled={p.busy}
                onChange={(e) => { const v = e.target.value; if (v) p.tasks?.onPick(v) }}
              >
                <option value="">Ask, or choose a task…</option>
                {p.tasks.groups.map((g) => (
                  <optgroup key={g.label} label={g.label}>
                    {g.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </optgroup>
                ))}
              </select>
            </label>
          )}
          <button type="button" className="achat__send" aria-label="Send" title="Send" onClick={() => p.onSend()} disabled={p.busy || !p.input.trim()}><MailIcon name="send" /></button>
        </div>
      </div>
    </section>
  )
}
