import { useState } from 'react'
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
  /** The text the box under the text is about, when the issues are for that text alone: its title already says it, so rows do not repeat it. */
  scope?: string
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

type Open = IssueCategory | 'corrections'

const sentence = (t: string): string => (t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Other')

/** Items that share a reason (twenty claims with "no source") are listed once under that reason. */
function groupByReason<T extends { detail?: string }>(items: T[]): { reason: string; items: T[] }[] {
  const groups = new Map<string, T[]>()
  for (const i of items) groups.set(i.detail ?? '', [...(groups.get(i.detail ?? '') ?? []), i])
  return [...groups].map(([reason, list]) => ({ reason, items: list }))
}

export function IssuesPanel(p: Props): React.JSX.Element {
  const { meta } = p
  const batches = collectIssues(meta)
  const total = issueCount(batches)
  const [open, setOpen] = useState<Open[]>([])
  const toggle = (c: Open): void => setOpen((o) => (o.includes(c) ? o.filter((x) => x !== c) : [...o, c]))
  const claimStart = (id: string): number => meta.claims.find((c) => c.id === id)?.position ?? 0

  const isScope = (quote: string | undefined): boolean => Boolean(p.scope && quote && quote.trim() === p.scope.trim())
  const claimItem = (i: { id: string; label: string; detail?: string }): React.JSX.Element => (
    <li key={i.id}>
      <div className="write__rowmain write__rowmain--line">{(() => {
        const quote = meta.claims.find((c) => c.id === i.id)?.quote
        const text = isScope(quote) ? 'This text' : (quote ?? i.label).replace(/\s+/g, ' ')
        return <button type="button" className="write__link write__linkline" title={text} onClick={() => p.onJump(claimStart(i.id))}>{text}</button>
      })()}</div>
    </li>
  )

  return (
    <>
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
      <div className="write__chips" role="group" aria-label="Kinds of issue">
        {batches.map((b) => (
          <button key={b.category} type="button" className={`write__issuechip ${open.includes(b.category) ? 'is-on' : ''}`} aria-expanded={open.includes(b.category)} onClick={() => toggle(b.category)}>
            {b.title} <span className="write__badge">{b.items.length + (b.needsYourChoice?.length ?? 0)}</span>
          </button>
        ))}
        {meta.corrections.length > 0 && (
          <button type="button" className={`write__issuechip ${open.includes('corrections') ? 'is-on' : ''}`} aria-expanded={open.includes('corrections')} onClick={() => toggle('corrections')}>
            What you corrected <span className="write__badge">{meta.corrections.length}</span>
          </button>
        )}
      </div>
      {batches.filter((b) => open.includes(b.category)).map((b) => (
        <section key={b.category} className="write__batch" aria-label={b.title}>
          <div className="write__batchhead">
            <span className="write__batchtitle">{b.title}</span>
            {b.items.length > 0 && (
              <button type="button" className="write__batchbtn" disabled={p.busy} title={ACTION[b.category].asks ? `${ACTION[b.category].label} with ${p.model}` : ACTION[b.category].label} onClick={() => p.onResolve(b.category)}>{ACTION[b.category].label}</button>
            )}
          </div>
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
                    {c.span && !isScope(c.span.quote) && <div className="write__reason">on “{c.span.quote.length > 80 ? `${c.span.quote.slice(0, 80)}…` : c.span.quote}”</div>}
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
          {(b.category === 'checkable' || b.category === 'unsupported') && groupByReason(b.items).map((g) => (
            <div key={g.reason} className="write__reasongroup">
              <h4 className="write__reasonhead">{sentence(g.reason || 'Other')} <span className="write__badge">{g.items.length}</span></h4>
              <ul className="write__rows">{g.items.map(claimItem)}</ul>
            </div>
          ))}
        </section>
      ))}
      {open.includes('corrections') && meta.corrections.length > 0 && (
        <section className="write__batch" aria-label="What you corrected">
          <div className="write__batchhead"><span className="write__batchtitle">What you corrected</span></div>
          <ul className="write__rows">
            {meta.corrections.map((c) => (
              <li key={c.id}>
                <div className="write__rowmain"><EditableText label="Correction" value={c.note} multiline onSave={(v) => p.onEditCorrection(c.id, v)} />{c.supersedes && <div className="write__reason">replaces: {c.supersedes}</div>}</div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}
