import { useState } from 'react'
import type { ArticleMeta, Idea } from '@buildaharness/aielia'
import { EditableText } from './EditableText'
import { IconButton } from './icons'

interface Props {
  meta: ArticleMeta
  busy: boolean
  /** The model used when Aielia suggests ideas or writes them in. */
  model: string
  onAdd(text: string): void
  onSuggest(request: string): void
  onEdit(id: string, text: string): void
  onWrite(ids: string[]): void
  onRemove(id: string): void
}

/**
 * Ideas: points, facts, quotes and angles, from the writer or from Aielia. Type one and press Enter; ask Aielia for more with a line of its own.
 * Click an idea to edit it. The arrow writes one idea into the article and the main button writes all that are waiting: they arrive as
 * suggested changes, and an idea counts as used when its suggestion is accepted.
 */
export function IdeasPanel({ meta, busy, model, onAdd, onSuggest, onEdit, onWrite, onRemove }: Props): React.JSX.Element {
  const [text, setText] = useState('')
  const [request, setRequest] = useState('')
  const name = (sid?: string): string | undefined => (sid ? meta.sections.find((s) => s.id === sid)?.heading || '(opening)' : undefined)
  const waiting = meta.ideas.filter((i) => i.state === 'open')
  const done = meta.ideas.filter((i) => i.state !== 'open')
  const who = (i: Idea): string => (i.origin === 'writer' ? 'You' : `Aielia${i.model ? ` · ${i.model}` : ''}`)

  return (
    <>
      <h2 className="write__panehead">Ideas</h2>
      <input aria-label="New idea" className="write__wide" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) { e.preventDefault(); onAdd(text); setText('') } }} placeholder="Type an idea and press Enter" />
      <input aria-label="Ask Aielia for ideas about" className="write__wide" value={request} disabled={busy} onChange={(e) => setRequest(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSuggest(request); setRequest('') } }} placeholder={`Ask ${model} for ideas: type a topic, or just press Enter`} />
      <ul className="write__rows write__ideas">
        {waiting.map((i) => (
          <li key={i.id}>
            <div className="write__rowmain">
              <EditableText label="Idea" value={i.text} multiline onSave={(v) => onEdit(i.id, v)} />
              <div className="write__reason">{who(i)}{name(i.sectionId) ? ` · for ${name(i.sectionId)}` : ''}</div>
            </div>
            <span className="write__rowacts">
              <IconButton label={`Write this into the article with ${model}`} icon="write" onClick={() => onWrite([i.id])} disabled={busy} />
              <IconButton label="Remove this idea" icon="close" onClick={() => onRemove(i.id)} />
            </span>
          </li>
        ))}
        {waiting.length === 0 && <li className="write__muted">No ideas waiting.</li>}
      </ul>
      {waiting.length > 1 && <button type="button" className="write__primary" onClick={() => onWrite(waiting.map((i) => i.id))} disabled={busy}>Write all {waiting.length} into the article</button>}
      {done.length > 0 && (
        <details className="write__allsrc">
          <summary>Written in ({done.length})</summary>
          <ul className="write__rows write__ideas">
            {done.map((i) => (
              <li key={i.id} className="is-done">
                <div className="write__rowmain">{i.text}<div className="write__reason">{who(i)} · {i.state === 'used' ? `written into ${name(i.usedIn) ?? 'the article'}` : 'set aside'}</div></div>
                <span className="write__rowacts"><IconButton label="Remove this idea" icon="close" onClick={() => onRemove(i.id)} /></span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  )
}
