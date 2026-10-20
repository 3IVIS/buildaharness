import { useState } from 'react'
import { DEPENDENCY_KINDS, DEPENDENCY_LABEL, dependenciesOf, type ArticleMeta, type DependencyKind } from '@buildaharness/aielia'
import { IconButton } from './icons'

interface Props {
  meta: ArticleMeta
  /** The section the selected text is in; undefined when nothing is selected or the section has not been read yet. */
  sectionId?: string
  busy: boolean
  model: string
  onFind(): void
  onConfirm(linkId: string): void
  onRemove(linkId: string, origin: string): void
  onAdd(from: string, to: string, kind: DependencyKind): void
}

/** Where the section holding the selected text depends on another section, and which sections depend on it. "Rests on" builds on the other section; "repeats" restates it. Change the other one and this one is flagged for review. */
export function LinksPanel({ meta, sectionId, busy, model, onFind, onConfirm, onRemove, onAdd }: Props): React.JSX.Element {
  const [to, setTo] = useState('')
  const [kind, setKind] = useState<DependencyKind>('rests_on')
  const name = (id: string): string => meta.sections.find((s) => s.id === id)?.heading || '(opening)'
  const here = sectionId ? meta.sections.find((s) => s.id === sectionId) : undefined
  const d = here ? dependenciesOf(meta, here.id) : undefined
  const row = (l: NonNullable<typeof d>['uses'][number], otherId: string, uses: boolean): React.JSX.Element => (
    <li key={l.id}>
      <div className="write__rowmain">
        {uses ? <>{DEPENDENCY_LABEL[l.kind as DependencyKind]} <strong>{name(otherId)}</strong></> : <><strong>{name(otherId)}</strong> {DEPENDENCY_LABEL[l.kind as DependencyKind]} this section</>}
        <span className="write__badge">{l.origin === 'proposed' ? `suggested${l.confidence !== undefined ? ` ${Math.round(l.confidence * 100)}%` : ''}` : l.origin === 'confirmed' ? 'confirmed' : 'drawn by you'}</span>
        {l.reason && <div className="write__reason">{l.reason}</div>}
      </div>
      <span className="write__rowacts">
        {l.origin === 'proposed' && <IconButton label="Confirm this link" icon="check" onClick={() => onConfirm(l.id)} />}
        <IconButton label={l.origin === 'proposed' ? 'Dismiss this link' : 'Remove this link'} icon="close" onClick={() => onRemove(l.id, l.origin)} />
      </span>
    </li>
  )
  return (
    <>
      {!here && <p className="write__muted">Click in the text, or highlight some, to see what its section links to.</p>}
      {here && d && (
        <>
          <p className="write__muted">Section: <strong>{here.heading || '(opening)'}</strong></p>
          <ul className="write__rows">
            {d.uses.map((l) => row(l, l.to.id, true))}
            {d.usedBy.map((l) => row(l, l.from.id, false))}
            {d.uses.length === 0 && d.usedBy.length === 0 && <li className="write__muted">Nothing links to or from this section yet.</li>}
          </ul>
          <details className="write__allsrc">
            <summary>Add one yourself</summary>
            <form className="write__linkform" onSubmit={(e) => { e.preventDefault(); if (to && to !== here.id) { onAdd(here.id, to, kind); setTo('') } }}>
              <select aria-label="Kind of link" value={kind} onChange={(e) => setKind(e.target.value as DependencyKind)}>
                {DEPENDENCY_KINDS.map((k) => <option key={k} value={k}>This section {DEPENDENCY_LABEL[k]}…</option>)}
              </select>
              <select aria-label="Section it depends on" value={to} onChange={(e) => setTo(e.target.value)}>
                <option value="">…which section?</option>
                {meta.sections.filter((x) => x.id !== here.id).map((x) => <option key={x.id} value={x.id}>{x.heading || '(opening)'}</option>)}
              </select>
              <button type="submit" disabled={!to}>Add link</button>
            </form>
          </details>
        </>
      )}
      <button type="button" className="write__link" onClick={onFind} disabled={busy || meta.sections.length < 2} title={`Find them with ${model}`}>Look for links between sections</button>
    </>
  )
}
