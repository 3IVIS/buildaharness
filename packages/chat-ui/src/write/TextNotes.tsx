import { useRef, useState } from 'react'
import { claimsInRange, commentsInRange, effectiveSourceStatus, matchFolderFiles, sourcesForClaim, textUnitAt, type ArticleMeta } from '@buildaharness/aielia'
import { EditableText } from './EditableText'
import { ICON_PATHS, Icon, IconButton } from './icons'

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

export type NoteKind = 'comment' | 'source' | 'say_so' | 'revise'

interface Props {
  meta: ArticleMeta
  markdown: string
  selection: { start: number; end: number } | null
  busy: boolean
  model: string
  /** Add what the writer typed, as a comment on the text, a source for it, or their own word. A source that is a link is stored as a link; anything else as a passage. */
  onAdd(kind: NoteKind, text: string): void
  onFiles(files: File[]): void
  onEditComment(id: string, text: string): void
  onResolveComment(id: string): void
  onDeleteComment(id: string): void
  onDetach(claimId: string, sourceId: string): void
  onConfirm(claimId: string, sourceId: string): void
  onRead(sourceId: string): void
  onAcceptNew(sourceId: string): void
  /** Asks the writer which lines of a file to keep. */
  onLines(sourceId: string): void
  /** Files of a folder on the writer's computer, once one was chosen; `onPickFolder` is absent where the browser cannot pick one. */
  folder?: { name: string; files: string[] }
  onPickFolder?: () => void
  onUseFolderFile(path: string): void
  onCloseFolder(): void
  onCheck(claimId: string): void
  /** Whether the page can search the web for a source. */
  canSearch: boolean
  /** Pages found for a claim, waiting for the writer to pick one. */
  candidates: Record<string, { title: string; url: string; snippet: string }[]>
  onFindSources(claimId: string): void
  onUseCandidate(claimId: string, url: string): void
  onDismissCandidates(claimId: string): void
}

const clip = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n)}…` : t)
export const looksLikeLink = (t: string): boolean => (t.startsWith('http://') || t.startsWith('https://')) && !t.includes(' ') && !t.includes('\n')

const PLACEHOLDER: Record<NoteKind, string> = {
  comment: 'Write a comment on this text',
  source: 'Paste a link or a passage that backs this text',
  say_so: 'What you know, in a sentence',
  revise: 'Ask Aielia to revise this text, for example: tighten it',
}

/**
 * Comments and sources for the text under the cursor, at the bottom of the page. Click in the text or highlight a phrase, a sentence, a
 * paragraph or a section: its comments and sources show here. One line adds to it: type a comment, paste a link or passage, or state your own
 * word; drop a file anywhere in this box, or use the paperclip.
 */
export function TextNotes({ meta, markdown, selection, busy, model, onAdd, onFiles, onEditComment, onResolveComment, onDeleteComment, onDetach, onConfirm, onRead, onAcceptNew, onLines, folder, onPickFolder, onUseFolderFile, onCloseFolder, onCheck, canSearch, candidates, onFindSources, onUseCandidate, onDismissCandidates }: Props): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(false)
  const [kind, setKind] = useState<NoteKind>('comment')
  const [text, setText] = useState('')
  const [over, setOver] = useState(false)
  const picker = useRef<HTMLInputElement | null>(null)
  const [fileQuery, setFileQuery] = useState('')
  const unit = selection ? textUnitAt(markdown, selection.start, selection.end) : undefined
  const claims = unit ? claimsInRange(meta, unit) : []
  const comments = unit ? commentsInRange(meta, unit) : []

  function submit(): void {
    const t = text.trim()
    if (!t || !unit) return
    onAdd(kind, t)
    setText('')
  }

  return (
    <section
      className={`write__dock ${over ? 'is-over' : ''}`}
      aria-label="Comments and sources for this text"
      onDragOver={(e) => { e.preventDefault(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const files = Array.from(e.dataTransfer.files); if (files.length > 0) onFiles(files) }}
    >
      <button type="button" className="write__dockhead" onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed} title={collapsed ? 'Show' : 'Hide'}>
        <strong>Comments and sources</strong>
        <span className="write__dockfor">{unit ? <>for “{clip(unit.quote, 70)}”</> : 'Click in the text, or highlight some, to comment or add a source'}</span>
      </button>
      {!collapsed && (
        <div className="write__dockbody">
          <div className="write__dockscroll">
            {unit && comments.length === 0 && claims.length === 0 && <p className="write__muted">Nothing here yet.</p>}
            <ul className="write__rows">
              {comments.map((c) => (
                <li key={c.id}>
                  <span className="write__rowicon" title="Comment"><Icon d={ICON_PATHS.comment} size={16} /></span>
                  <div className="write__rowmain"><EditableText label="Comment" value={c.text} multiline onSave={(v) => onEditComment(c.id, v)} /></div>
                  <span className="write__rowacts">
                    {c.state === 'open' ? <IconButton label="Mark as dealt with" icon="check" onClick={() => onResolveComment(c.id)} /> : <span className="write__badge">{c.state}</span>}
                    <IconButton label="Delete the comment" icon="close" onClick={() => onDeleteComment(c.id)} />
                  </span>
                </li>
              ))}
              {claims.map((c) => {
                const srcs = sourcesForClaim(meta, c.id)
                const status = effectiveSourceStatus(c, meta.sources)
                return (
                  <li key={c.id} className="write__claimrow">
                    <span className="write__rowicon" title="Claim"><Icon d={ICON_PATHS.source} size={16} /></span>
                    <div className="write__rowmain">
                      <span>{clip(c.quote, 120)}</span> <span className={`write__badge write__badge--${status}`}>{STATUS_LABEL[status] ?? status}</span>
                      {srcs.length === 0 && <div className="write__reason">No source yet.</div>}
                      {candidates[c.id] && (
                        <div className="write__found" role="group" aria-label="Pages that may back this claim">
                          {candidates[c.id].length === 0 && <div className="write__reason">The search found nothing new.</div>}
                          {candidates[c.id].map((r) => (
                            <div key={r.url} className="write__dsrc">
                              <span className="write__dsrcname">{r.title || r.url}</span>
                              <span className="write__rowacts"><IconButton label={`Use ${r.title || r.url} as a source`} icon="check" onClick={() => onUseCandidate(c.id, r.url)} disabled={busy} /></span>
                              <div className="write__reason">{r.url}{r.snippet ? ` · ${clip(r.snippet, 140)}` : ''}</div>
                            </div>
                          ))}
                          <button type="button" className="write__link" onClick={() => onDismissCandidates(c.id)}>Dismiss these</button>
                        </div>
                      )}
                      {srcs.map((s) => {
                        const link = meta.links.find((l) => l.kind === 'supported_by' && l.from.id === c.id && l.to.id === s.id)
                        const proposed = link?.origin === 'proposed'
                        return (
                          <div key={s.id} className="write__dsrc">
                            <span className="write__dsrcname">{s.kind === 'say_so' ? 'Your word' : s.address ?? s.kind}{s.lines ? ` · lines ${s.lines.from}–${s.lines.to}` : ''}</span>
                            <span className="write__badge">{proposed ? `suggested${link?.confidence !== undefined ? ` ${Math.round(link.confidence * 100)}%` : ''}` : s.freshness}</span>
                            <span className="write__rowacts">
                              {proposed && <IconButton label="Use this source" icon="check" onClick={() => onConfirm(c.id, s.id)} />}
                              {(s.kind === 'web' || s.kind === 'code') && s.address && /^https?:/.test(s.address) && <IconButton label={s.passage ? 'Read the page again' : 'Read the page'} icon="restore" onClick={() => onRead(s.id)} disabled={busy} />}
                              {s.kind !== 'say_so' && s.passage !== undefined && <IconButton label={s.lines ? 'Change which lines are kept' : 'Keep only some lines'} icon="lines" onClick={() => onLines(s.id)} disabled={busy} />}
                              {s.fetchedPassage && <IconButton label="Use the new text of this page" icon="check2" onClick={() => onAcceptNew(s.id)} />}
                              <IconButton label={proposed ? 'Dismiss this suggestion' : 'Remove this source from the text'} icon="close" onClick={() => onDetach(c.id, s.id)} />
                            </span>
                            <div className="write__reason">{link?.reason ? `${link.reason} · ` : ''}{s.note ?? (s.passage ? clip(s.passage, 140) : 'A link only: paste the passage to check against it.')}{s.fetchedPassage ? (s.kind === 'code' ? ' · The file has changed since you read it.' : ' · The page has changed since you read it.') : ''}</div>
                          </div>
                        )
                      })}
                    </div>
                    <span className="write__rowacts">{canSearch && <IconButton label="Find sources for this claim" icon="view" onClick={() => onFindSources(c.id)} disabled={busy} />}<IconButton label={`Check this claim with ${model}`} icon="check2" onClick={() => onCheck(c.id)} disabled={busy || srcs.length === 0} /></span>
                  </li>
                )
              })}
            </ul>
          </div>
          {folder && (
            <div className="write__found" role="group" aria-label="Files in the folder">
              <div className="write__dsrc">
                <span className="write__dsrcname">{folder.name} · {folder.files.length} files</span>
                <span className="write__rowacts"><IconButton label="Close the folder" icon="close" onClick={onCloseFolder} /></span>
              </div>
              <input aria-label="Find a file in the folder" value={fileQuery} onChange={(e) => setFileQuery(e.target.value)} placeholder="Type part of a file name" />
              {matchFolderFiles(folder.files, fileQuery).map((f) => (
                <button key={f} type="button" className="write__link" disabled={!unit || busy} title={unit ? 'Use this file as a source for the text' : 'Click in the text first'} onClick={() => onUseFolderFile(f)}>{f}</button>
              ))}
            </div>
          )}
          <div className="write__dockadd" role="group" aria-label="Add to this text">
            <div className="write__seg" role="group" aria-label="What to add">
              {(['comment', 'source', 'say_so', 'revise'] as const).map((k) => (
                <button key={k} type="button" aria-pressed={kind === k} className={kind === k ? 'is-on' : ''} onClick={() => setKind(k)}>{k === 'comment' ? 'Comment' : k === 'source' ? 'Source' : k === 'say_so' ? 'My word' : 'Revise'}</button>
              ))}
            </div>
            <input
              aria-label="Add to this text"
              value={text}
              disabled={!unit}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } }}
              placeholder={unit ? PLACEHOLDER[kind] : 'Click in the text first'}
            />
            <button type="button" className="write__iconbtn" aria-label="Add a file as a source" title="Add a file as a source" onClick={() => picker.current?.click()}><Icon d={ICON_PATHS.attach} /></button>
            {onPickFolder && <button type="button" className="write__iconbtn" aria-label="Use files from a folder on this computer" title="Use files from a folder on this computer" onClick={onPickFolder}><Icon d={ICON_PATHS.folder} /></button>}
            <input ref={picker} type="file" multiple hidden aria-label="Choose files" onChange={(e) => { const files = Array.from(e.target.files ?? []); if (files.length > 0) onFiles(files); e.target.value = '' }} />
          </div>
        </div>
      )}
    </section>
  )
}
