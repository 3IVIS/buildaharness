import { useState } from 'react'
import type { ArticleMeta, Idea } from '@buildaharness/aielia'

interface Props {
  meta: ArticleMeta
  busy: boolean
  /** The model used when the assistant suggests ideas or writes them in. */
  model: string
  onAdd(text: string, sectionId: string | undefined): void
  onSuggest(request: string): void
  onWrite(ids: string[], instruction: string): void
  onState(id: string, state: Idea['state']): void
  onRemove(id: string): void
}

/** Ideas: material the writer and the assistant collect. Chosen ideas are written into the article as suggestions the writer accepts. */
export function IdeasPanel({ meta, busy, model, onAdd, onSuggest, onWrite, onState, onRemove }: Props): React.JSX.Element {
  const [text, setText] = useState('')
  const [section, setSection] = useState('')
  const [request, setRequest] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [how, setHow] = useState('')
  const name = (sid?: string): string | undefined => (sid ? meta.sections.find((s) => s.id === sid)?.heading || '(opening)' : undefined)
  const open = meta.ideas.filter((i) => i.state === 'open')
  const rest = meta.ideas.filter((i) => i.state !== 'open')
  const toggle = (id: string): void => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
  const chosen = picked.filter((id) => open.some((i) => i.id === id))

  const row = (i: Idea): React.JSX.Element => (
    <li key={i.id} className={i.state === 'open' ? '' : 'is-done'}>
      <label className="write__ideatext">
        {i.state === 'open' && <input type="checkbox" checked={picked.includes(i.id)} onChange={() => toggle(i.id)} aria-label={`Choose: ${i.text}`} />}
        <span>{i.text}</span>
      </label>
      <p className="write__reason">
        {i.origin === 'writer' ? 'You' : `Aielia${i.model ? ` · ${i.model}` : ''}`}
        {name(i.sectionId) ? ` · for ${name(i.sectionId)}` : ''}
        {i.state === 'used' ? ` · written into ${name(i.usedIn) ?? 'the article'}` : i.state === 'dropped' ? ' · set aside' : ''}
      </p>
      {i.state === 'open' && <button type="button" onClick={() => onState(i.id, 'dropped')}>Set aside</button>}
      {i.state !== 'open' && <button type="button" onClick={() => onState(i.id, 'open')}>Reopen</button>}
      <button type="button" onClick={() => onRemove(i.id)}>Remove</button>
    </li>
  )

  return (
    <>
      <h2 className="write__panehead">Ideas</h2>
      <p className="write__muted">Points, facts, quotes and angles for the article, from you or from Aielia. Choose some and write them into the text: they arrive as suggested changes you accept.</p>
      <form className="write__form" onSubmit={(e) => { e.preventDefault(); if (text.trim()) { onAdd(text, section || undefined); setText(''); setSection('') } }}>
        <textarea aria-label="New idea" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="An idea, a fact, a quote…" />
        <select aria-label="Section the idea is for" value={section} onChange={(e) => setSection(e.target.value)}>
          <option value="">Not tied to a section</option>
          {meta.sections.map((s) => <option key={s.id} value={s.id}>{s.heading || '(opening)'}</option>)}
        </select>
        <button type="submit" disabled={!text.trim()}>Add idea</button>
      </form>
      <div className="write__form">
        <input aria-label="What to find ideas about" value={request} onChange={(e) => setRequest(e.target.value)} placeholder="Ideas about… (optional)" />
        <button type="button" onClick={() => onSuggest(request)} disabled={busy}>Suggest ideas with {model}</button>
      </div>
      <h3>To write in ({open.length})</h3>
      <ul className="write__list write__ideas">
        {open.map(row)}
        {open.length === 0 && <li className="write__muted">Nothing waiting. Add an idea, or ask Aielia for some.</li>}
      </ul>
      {open.length > 0 && (
        <div className="write__form">
          <input aria-label="How to write them in" value={how} onChange={(e) => setHow(e.target.value)} placeholder="How? (optional, e.g. keep it to one paragraph)" />
          <button type="button" onClick={() => onWrite(chosen, how)} disabled={busy || chosen.length === 0}>Write {chosen.length || 'the chosen'} into the article with {model}</button>
        </div>
      )}
      {rest.length > 0 && (
        <details className="write__allsrc">
          <summary>Used or set aside ({rest.length})</summary>
          <ul className="write__list write__ideas">{rest.map(row)}</ul>
        </details>
      )}
    </>
  )
}
