import { useState } from 'react'
import { claimsInRange, effectiveSourceStatus, sourcesForClaim, textUnitAt, type ArticleMeta, type Source } from '@buildaharness/aielia'

const STATUS_LABEL: Record<string, string> = {
  none: 'no source',
  attached: 'attached, not checked',
  supported: 'supported',
  partly_supported: 'partly supported',
  not_supported: 'not supported',
  contradicted: 'contradicted',
  stale: 'stale',
  not_checked: 'not checked',
}

export interface NewSource {
  kind: Source['kind']
  address?: string
  passage?: string
  note?: string
}

interface Props {
  meta: ArticleMeta
  markdown: string
  selection: { start: number; end: number } | null
  busy: boolean
  /** The model a check started here will use. */
  model: string
  onAdd(source: NewSource, attachHere: boolean): void
  onDropFiles(files: File[], attachHere: boolean): void
  onDetach(claimId: string, sourceId: string): void
  onConfirm(claimId: string, sourceId: string): void
  onCheck(claimId: string): void
}

const clip = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n)}…` : t)

/**
 * Sources for the text under the cursor, at the bottom of the page. Click in the text (or select a phrase) and the sources for that
 * phrase, sentence or paragraph show here. Drop a file, or paste a link, a passage or your own word, and it is attached to that text.
 * A source dropped into the chat is stored and the assistant proposes where it belongs; those proposals show here, for the text they concern.
 */
export function SourceDock({ meta, markdown, selection, busy, model, onAdd, onDropFiles, onDetach, onConfirm, onCheck }: Props): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(false)
  const [kind, setKind] = useState<'passage' | 'link' | 'say_so'>('passage')
  const [text, setText] = useState('')
  const [over, setOver] = useState(false)
  const unit = selection ? textUnitAt(markdown, selection.start, selection.end) : undefined
  const claims = unit ? claimsInRange(meta, unit) : []
  const attachHere = unit !== undefined
  const unattached = meta.sources.filter((s) => !meta.links.some((l) => l.kind === 'supported_by' && l.to.id === s.id))

  function submit(): void {
    const t = text.trim()
    if (!t) return
    if (kind === 'link') onAdd({ kind: 'web', address: t }, attachHere)
    else if (kind === 'say_so') onAdd({ kind: 'say_so', note: t }, attachHere)
    else onAdd({ kind: 'upload', passage: t }, attachHere)
    setText('')
  }

  return (
    <section className={`write__dock ${over ? 'is-over' : ''}`} aria-label="Sources for this text"
      onDragOver={(e) => { e.preventDefault(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const files = Array.from(e.dataTransfer.files); if (files.length > 0) onDropFiles(files, attachHere) }}>
      <header className="write__dockhead">
        <strong>Sources</strong>
        <span className="write__dockfor">{unit ? <>for “{clip(unit.quote, 70)}”</> : 'Click in the text to see its sources'}</span>
        <button type="button" className="write__link" onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed}>{collapsed ? 'Show' : 'Hide'}</button>
      </header>
      {!collapsed && (
        <div className="write__dockbody">
          <div className="write__dockscroll">
          {unit && claims.length === 0 && <p className="write__muted">No claim is recorded for this text yet. Add a source below and it becomes one.</p>}
          <ul className="write__list">
            {claims.map((c) => {
              const srcs = sourcesForClaim(meta, c.id)
              const status = effectiveSourceStatus(c, meta.sources)
              return (
                <li key={c.id}>
                  <p>{c.quote} <span className={`write__badge write__badge--${status}`}>{STATUS_LABEL[status] ?? status}</span></p>
                  {srcs.length === 0 && <p className="write__reason">No source attached.</p>}
                  {srcs.map((s) => {
                    const link = meta.links.find((l) => l.kind === 'supported_by' && l.from.id === c.id && l.to.id === s.id)
                    return (
                      <div key={s.id} className="write__dsrc">
                        <strong>{s.kind === 'say_so' ? 'Your word' : s.address ?? s.kind}</strong>
                        <span className="write__badge">{link?.origin === 'proposed' ? `suggested${link.confidence !== undefined ? ` ${Math.round(link.confidence * 100)}%` : ''}` : s.freshness}</span>
                        {s.trust === 'lower' && <span className="write__badge">lower trust</span>}
                        <p className="write__reason">{link?.reason ? `${link.reason} · ` : ''}{s.note ?? (s.passage ? clip(s.passage, 140) : s.address && !s.passage ? 'Link saved. The page is not fetched yet: paste the passage to check against it.' : '')}</p>
                        {link?.origin === 'proposed' && <button type="button" onClick={() => onConfirm(c.id, s.id)}>Confirm</button>}
                        <button type="button" onClick={() => onDetach(c.id, s.id)}>{link?.origin === 'proposed' ? 'Dismiss' : 'Detach'}</button>
                      </div>
                    )
                  })}
                  <button type="button" onClick={() => onCheck(c.id)} disabled={busy || srcs.length === 0} title={`Check this claim with ${model}`}>Check with {model}</button>
                </li>
              )
            })}
          </ul>
          </div>
          <div className="write__dockfoot">
          <div className="write__dropzone">
            <div className="write__dockform">
              <select aria-label="Kind of source" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                <option value="passage">A passage</option>
                <option value="link">A link</option>
                <option value="say_so">My own word</option>
              </select>
              <textarea aria-label="Source text" rows={1} value={text} onChange={(e) => setText(e.target.value)} placeholder={kind === 'link' ? 'https://…' : kind === 'say_so' ? 'What you know, in a sentence' : 'Paste the passage'} />
              <button type="button" onClick={submit} disabled={busy || !text.trim()}>Add source</button>
              <label className="write__filepick">Choose a file<input type="file" multiple onChange={(e) => { const files = Array.from(e.target.files ?? []); if (files.length > 0) onDropFiles(files, attachHere); e.target.value = '' }} /></label>
            </div>
            <p className="write__muted write__hint">{attachHere ? 'Adds to the text above. You can also drop a file anywhere in this box.' : 'Stored, then Aielia proposes where it belongs. You can also drop a file anywhere in this box.'}</p>
          </div>
          {meta.sources.length > 0 && (
            <details className="write__allsrc">
              <summary>All sources ({meta.sources.length}){unattached.length > 0 ? `, ${unattached.length} not attached to any text` : ''}</summary>
              <ul className="write__list">
                {meta.sources.map((s) => <li key={s.id}><strong>{s.kind === 'say_so' ? 'Your word' : s.address ?? s.kind}</strong> <span className="write__badge">{s.freshness}</span></li>)}
              </ul>
            </details>
          )}
          </div>
        </div>
      )}
    </section>
  )
}
