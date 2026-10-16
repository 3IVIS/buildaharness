import { useState } from 'react'
import { DEPENDENCY_KINDS, DEPENDENCY_LABEL, type ArticleMeta, type DependencyKind } from '@buildaharness/aielia'
import { IconButton } from './icons'

interface Props {
  meta: ArticleMeta
  busy: boolean
  model: string
  onFind(): void
  onConfirm(linkId: string): void
  onRemove(linkId: string, origin: string): void
  onAdd(from: string, to: string, kind: DependencyKind): void
}

/** Where one section depends on another: "rests on" builds on it, "repeats" restates it. Change the second and the first is flagged for review. */
export function LinksPanel({ meta, busy, model, onFind, onConfirm, onRemove, onAdd }: Props): React.JSX.Element {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [kind, setKind] = useState<DependencyKind>('rests_on')
  const name = (id: string): string => meta.sections.find((s) => s.id === id)?.heading || '(opening)'
  const links = meta.links.filter((l) => (DEPENDENCY_KINDS as readonly string[]).includes(l.kind) && l.from.type === 'section' && l.to.type === 'section')
  return (
    <>
      <h2 className="write__panehead">Links between sections</h2>
      <p className="write__muted">“Rests on” means it builds on the other section; “repeats” means it restates it. Change the other one and this one is flagged for review.</p>
      <button type="button" onClick={onFind} disabled={busy || meta.sections.length < 2} title={`Find them with ${model}`}>Find links</button>
      <ul className="write__rows">
        {links.map((l) => (
          <li key={l.id}>
            <div className="write__rowmain">
              <strong>{name(l.from.id)}</strong> {DEPENDENCY_LABEL[l.kind as DependencyKind]} <strong>{name(l.to.id)}</strong>
              <span className="write__badge">{l.origin === 'proposed' ? `suggested${l.confidence !== undefined ? ` ${Math.round(l.confidence * 100)}%` : ''}` : l.origin === 'confirmed' ? 'confirmed' : 'drawn by you'}</span>
              {l.reason && <div className="write__reason">{l.reason}</div>}
            </div>
            <span className="write__rowacts">
              {l.origin === 'proposed' && <IconButton label="Confirm this link" icon="check" onClick={() => onConfirm(l.id)} />}
              <IconButton label={l.origin === 'proposed' ? 'Dismiss this link' : 'Remove this link'} icon="close" onClick={() => onRemove(l.id, l.origin)} />
            </span>
          </li>
        ))}
        {links.length === 0 && <li className="write__muted">No links yet.</li>}
      </ul>
      <details className="write__allsrc">
        <summary>Add one yourself</summary>
        <form className="write__linkform" onSubmit={(e) => { e.preventDefault(); if (from && to && from !== to) { onAdd(from, to, kind); setFrom(''); setTo('') } }}>
          <select aria-label="Section that depends" value={from} onChange={(e) => setFrom(e.target.value)}>
            <option value="">This section…</option>
            {meta.sections.map((x) => <option key={x.id} value={x.id}>{x.heading || '(opening)'}</option>)}
          </select>
          <select aria-label="Kind of link" value={kind} onChange={(e) => setKind(e.target.value as DependencyKind)}>
            {DEPENDENCY_KINDS.map((k) => <option key={k} value={k}>{DEPENDENCY_LABEL[k]}</option>)}
          </select>
          <select aria-label="Section it depends on" value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">…this section</option>
            {meta.sections.filter((x) => x.id !== from).map((x) => <option key={x.id} value={x.id}>{x.heading || '(opening)'}</option>)}
          </select>
          <button type="submit" disabled={!from || !to || from === to}>Add link</button>
        </form>
      </details>
    </>
  )
}
