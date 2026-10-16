import type { IssueCategory } from '@buildaharness/aielia'
import { collectIssues, issueCount, type ArticleMeta } from '@buildaharness/aielia'
import { EditableText } from './EditableText'
import { IconButton } from './icons'

export interface ResolveNote {
  category: IssueCategory
  done: number
  note: string
}

interface Props {
  meta: ArticleMeta
  busy: boolean
  model: string
  notes: ResolveNote[]
  onResolve(category: IssueCategory): void
  onResolveAll(): void
  onClearNotes(): void
  onAccept(id: string): void
  onReject(id: string): void
  onEditSuggestion(id: string, text: string): void
  onCommentState(id: string, state: 'addressed' | 'dismissed'): void
  onEditComment(id: string, text: string): void
  onClearSection(id: string): void
  onConfirmLink(id: string): void
  onRemoveLink(id: string): void
  onEditCorrection(id: string, text: string): void
  onJump(start: number): void
}

/** What each category's one button does. The ones that ask Aielia for text say the model, and only ever produce suggested changes. */
const ACTION: Record<IssueCategory, { label: string; asks: boolean }> = {
  suggestions: { label: 'Accept all', asks: false },
  comments: { label: 'Suggest fixes', asks: true },
  checkable: { label: 'Check all', asks: true },
  unsupported: { label: 'Suggest fixes', asks: true },
  sections: { label: 'Suggest fixes', asks: true },
  links: { label: 'Confirm all', asks: false },
  stale: { label: 'Dismiss all', asks: false },
}

export function IssuesPanel(p: Props): React.JSX.Element {
  const { meta } = p
  const batches = collectIssues(meta)
  const total = issueCount(batches)
  const claimStart = (id: string): number => meta.claims.find((c) => c.id === id)?.position ?? 0

  return (
    <>
      <h2 className="write__panehead">Issues</h2>
      <div className="write__resolvebar">
        <span className="write__muted">{total === 0 ? 'Nothing needs your attention.' : `${total} to deal with, in ${batches.length} group${batches.length === 1 ? '' : 's'}.`}</span>
        {total > 0 && <button type="button" className="write__primary" onClick={p.onResolveAll} disabled={p.busy} title={`Does each group's action in turn. Text changes arrive as suggestions. Uses ${p.model}.`}>Resolve all</button>}
      </div>
      {p.notes.length > 0 && (
        <ul className="write__notes" aria-label="What just happened">
          {p.notes.map((n) => <li key={n.category}>{n.note}</li>)}
          <li><button type="button" className="write__link" onClick={p.onClearNotes}>Dismiss</button></li>
        </ul>
      )}
      {batches.map((b) => (
        <details key={b.category} open className="write__batch">
          <summary>
            <span className="write__batchtitle">{b.title}</span>
            <span className="write__badge">{b.items.length + (b.needsYourChoice?.length ?? 0)}</span>
            {b.items.length > 0 && (
              <button type="button" className="write__batchbtn" disabled={p.busy} title={ACTION[b.category].asks ? `${ACTION[b.category].label} with ${p.model}` : ACTION[b.category].label} onClick={(e) => { e.preventDefault(); e.stopPropagation(); p.onResolve(b.category) }}>{ACTION[b.category].label}</button>
            )}
          </summary>
          <ul className="write__rows">
            {b.category === 'suggestions' && meta.suggestions.filter((s) => s.state === 'pending').map((s) => (
              <li key={s.id}>
                <div className="write__rowmain">
                  <del>{s.span.quote}</del> → <ins><EditableText label={`Replacement text for ${s.span.quote}`} value={s.replacement} multiline allowEmpty onSave={(v) => p.onEditSuggestion(s.id, v)} /></ins>
                  <div className="write__reason">{s.reason}{s.model ? ` · ${s.model}` : ''}</div>
                </div>
                <span className="write__rowacts"><IconButton label="Accept" icon="check" onClick={() => p.onAccept(s.id)} /><IconButton label="Reject" icon="close" onClick={() => p.onReject(s.id)} /></span>
              </li>
            ))}
            {b.category === 'comments' && b.items.map((i) => {
              const c = meta.comments.find((x) => x.id === i.id)
              if (!c) return null
              return (
                <li key={c.id}>
                  <div className="write__rowmain">
                    {c.label ? <strong>{c.label}{c.reviewer ? ` (${c.reviewer})` : ''}: </strong> : null}
                    <EditableText label={`Comment ${c.label ?? c.id}`} value={c.text} multiline onSave={(v) => p.onEditComment(c.id, v)} />
                    {c.span && <div className="write__reason">on “{c.span.quote.length > 80 ? `${c.span.quote.slice(0, 80)}…` : c.span.quote}”</div>}
                    {c.decision && <div className="write__reason">You decided: {c.decision}</div>}
                  </div>
                  <span className="write__rowacts"><IconButton label="Mark as dealt with" icon="check" onClick={() => p.onCommentState(c.id, 'addressed')} /><IconButton label="Dismiss the comment" icon="close" onClick={() => p.onCommentState(c.id, 'dismissed')} /></span>
                </li>
              )
            })}
            {b.category === 'comments' && (b.needsYourChoice ?? []).map((i) => {
              const c = meta.comments.find((x) => x.id === i.id)
              if (!c) return null
              const others = c.conflictsWith.map((id) => meta.comments.find((x) => x.id === id)?.label ?? id).join(', ')
              return (
                <li key={c.id} className="write__choice">
                  <div className="write__rowmain">
                    <strong>{c.label ?? c.id}: </strong>{c.text}
                    <div className="write__warn">Conflicts with {others}. Aielia will not choose; decide in the chat or mark one as dealt with.</div>
                  </div>
                  <span className="write__rowacts"><IconButton label="Mark as dealt with" icon="check" onClick={() => p.onCommentState(c.id, 'addressed')} /><IconButton label="Dismiss the comment" icon="close" onClick={() => p.onCommentState(c.id, 'dismissed')} /></span>
                </li>
              )
            })}
            {(b.category === 'checkable' || b.category === 'unsupported') && b.items.map((i) => (
              <li key={i.id}>
                <div className="write__rowmain"><button type="button" className="write__link" onClick={() => p.onJump(claimStart(i.id))}>{i.label}</button>{i.detail && <span className="write__badge">{i.detail}</span>}</div>
              </li>
            ))}
            {b.category === 'sections' && b.items.map((i) => (
              <li key={i.id}>
                <div className="write__rowmain"><strong>{i.label}</strong>{i.detail && <div className="write__reason">{i.detail}</div>}</div>
                <span className="write__rowacts"><IconButton label="Mark as reviewed" icon="check" onClick={() => p.onClearSection(i.id)} /></span>
              </li>
            ))}
            {b.category === 'links' && b.items.map((i) => (
              <li key={i.id}>
                <div className="write__rowmain">{i.label}{i.detail && <div className="write__reason">{i.detail}</div>}</div>
                <span className="write__rowacts"><IconButton label="Confirm" icon="check" onClick={() => p.onConfirmLink(i.id)} /><IconButton label="Dismiss" icon="close" onClick={() => p.onRemoveLink(i.id)} /></span>
              </li>
            ))}
            {b.category === 'stale' && b.items.map((i) => (
              <li key={i.id}>
                <div className="write__rowmain">{i.label}</div>
                <span className="write__rowacts"><IconButton label="Dismiss" icon="close" onClick={() => p.onReject(i.id)} /></span>
              </li>
            ))}
          </ul>
        </details>
      ))}
      {meta.corrections.length > 0 && (
        <details open className="write__batch">
          <summary><span className="write__batchtitle">What you corrected</span><span className="write__badge">{meta.corrections.length}</span></summary>
          <ul className="write__rows">
            {meta.corrections.map((c) => (
              <li key={c.id}>
                <div className="write__rowmain"><EditableText label="Correction" value={c.note} multiline onSave={(v) => p.onEditCorrection(c.id, v)} />{c.supersedes && <div className="write__reason">replaces: {c.supersedes}</div>}</div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  )
}
