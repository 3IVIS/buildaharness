import { useEffect, useLayoutEffect, useRef } from 'react'
import { MailIcon } from './mail-ui'

export interface AielaChatLine { id: number; from: 'you' | 'aielia'; text: string }

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
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
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
        {p.lines.map((l) => <li key={l.id} className={`achat__line achat__line--${l.from}`} data-from={l.from}>{l.text}</li>)}
        {p.lines.length === 0 && (
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
        <button type="button" className="achat__send" aria-label="Send" title="Send" onClick={() => p.onSend()} disabled={p.busy || !p.input.trim()}><MailIcon name="send" /></button>
      </div>
    </section>
  )
}
