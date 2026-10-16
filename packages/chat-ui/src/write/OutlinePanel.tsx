import { DEPENDENCY_LABEL, dependenciesOf, type ArticleMeta, type DependencyKind } from '@buildaharness/aielia'
import { EditableText } from './EditableText'
import { IconButton } from './icons'

interface Props {
  meta: ArticleMeta
  onJump(start: number): void
  onRename(sectionId: string, heading: string): void
  onPurpose(sectionId: string, purpose: string): void
  onClear(sectionId: string): void
}

/** The headings of the text. Click one to go there, double-click to rename it (the heading in the text changes), click the line under it to say what the section is for. */
export function OutlinePanel({ meta, onJump, onRename, onPurpose, onClear }: Props): React.JSX.Element {
  const name = (sid: string): string => meta.sections.find((x) => x.id === sid)?.heading || '(opening)'
  const base = Math.min(...meta.sections.filter((x) => x.level > 1).map((x) => x.level), 2)
  return (
    <>
      <h2 className="write__panehead">Outline</h2>
      <p className="write__muted">Click a heading to go there. Double-click to rename it.</p>
      <ul className="write__rows write__outline">
        {meta.sections.map((sec) => {
          const isTitle = sec.level === 1
          const depth = isTitle ? 0 : Math.max(0, sec.level - base)
          const d = dependenciesOf(meta, sec.id)
          const deps = [
            ...d.uses.map((l) => `${DEPENDENCY_LABEL[l.kind as DependencyKind]} ${name(l.to.id)}${l.origin === 'proposed' ? ' (suggested)' : ''}`),
            ...(d.usedBy.length > 0 ? [`used by ${d.usedBy.map((l) => name(l.from.id)).join(', ')}`] : []),
          ]
          return (
            <li key={sec.id} className={`${isTitle ? 'write__outline-title' : ''} ${depth > 0 ? 'is-nested' : ''}`} style={{ marginLeft: `${depth * 16}px` }}>
              <div className="write__rowmain">
                {sec.level === 0
                  ? <button type="button" className="write__link" onClick={() => onJump(sec.span.start)}>(opening)</button>
                  : <EditableText label={`Heading: ${sec.heading}`} value={sec.heading} trigger="dblclick" onActivate={() => onJump(sec.span.start)} onSave={(v) => onRename(sec.id, v)} className="write__headingtext" />}
                {sec.review.state !== 'clean' && <span className={`write__badge write__badge--${sec.review.state}`}>{sec.review.state === 'needs_review' ? 'needs review' : sec.review.state.replace('_', ' ')}</span>}
                <div><EditableText label={`Purpose of ${sec.heading || 'the opening'}`} value={sec.purpose ?? ''} placeholder="What is this section for?" allowEmpty onSave={(v) => onPurpose(sec.id, v)} className="write__purpose" /></div>
                {deps.length > 0 && <div className="write__reason">{deps.join(' · ')}</div>}
                {sec.review.reason && <div className="write__reason">{sec.review.reason}</div>}
              </div>
              {sec.review.state === 'needs_review' && <span className="write__rowacts"><IconButton label="Mark as reviewed" icon="check" onClick={() => onClear(sec.id)} /></span>}
            </li>
          )
        })}
      </ul>
    </>
  )
}
