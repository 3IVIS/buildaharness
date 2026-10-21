import { useEffect, useRef, useState, type ReactNode } from 'react'
import { lookupNote, claimsInRange, commentsInRange, effectiveSourceStatus, matchFolderFiles, sourcesForClaim, textUnitAt, type ArticleMeta } from '@buildaharness/aielia'
import { ICON_PATHS, Icon, IconButton } from './icons'
import { Splitter } from './Splitter'

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

export type NoteKind = 'comment' | 'source'

export interface CommentChanges {
  edit: { id: string; text: string }[]
  add: string[]
  remove: string[]
}

/** The comments as free text: one per paragraph, separated by a blank line. */
export const commentsToText = (texts: string[]): string => texts.join('\n\n')

/** What changed between the open comments and the text the writer left: paragraphs pair up with the comments in order. */
export function commentChanges(open: { id: string; text: string }[], value: string): CommentChanges {
  const paragraphs = value.split(/\n[ \t]*\n/).map((t) => t.trim()).filter(Boolean)
  const edit: CommentChanges['edit'] = []
  for (let i = 0; i < Math.min(open.length, paragraphs.length); i++) if (open[i].text.trim() !== paragraphs[i]) edit.push({ id: open[i].id, text: paragraphs[i] })
  return { edit, add: paragraphs.slice(open.length), remove: open.slice(paragraphs.length).map((c) => c.id) }
}

export type DockPane = 'comments' | 'sources' | 'issues' | 'links' | 'history'

interface Props {
  /** The other panes of the box, drawn by the page: what needs attention in the article, how the selected text links, how it read before. */
  issues: ReactNode
  issuesCount: number
  links: ReactNode
  history: ReactNode
  meta: ArticleMeta
  markdown: string
  selection: { start: number; end: number } | null
  /** The unit the selection was grown to with Select more (sentence, paragraph, section, article), when it was. */
  grownUnit?: string
  busy: boolean
  model: string
  /** How tall the writer dragged the box to, in pixels; undefined is its normal height. */
  height?: number
  /** Hides the box; the button for it sits in the box's top corner so it takes no room of its own. */
  onHide(): void
  onHeight(px: number | undefined): void
  /** Add what the writer typed, as a comment on the text or a source for it. A source that is a link is stored as a link; anything else as a passage. */
  onAdd(kind: NoteKind, text: string): void
  onFiles(files: File[]): void
  /** The comments on the selected text after the writer edited them as free text: the ones reworded, the new ones, the ones taken out. */
  onSaveComments(changes: CommentChanges): void
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
  /** Looks for sources for a claim that has none, reads them and checks the claim. */
  onVerify(claimId: string): void
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
}

const PANES: { id: DockPane; label: string }[] = [
  { id: 'comments', label: 'Comments' },
  { id: 'sources', label: 'Sources' },
  { id: 'issues', label: 'Issues' },
  { id: 'links', label: 'Links' },
  { id: 'history', label: 'History' },
]

/**
 * Comments and sources for the text under the cursor, at the bottom of the page. Click in the text or highlight a phrase, a sentence, a
 * paragraph or a section: its comments and sources show here. One line adds to it: type a comment, paste a link or passage, or state your own
 * word; drop a file anywhere in this box, or use the paperclip.
 */
export function TextNotes({ issues, issuesCount, links, history, meta, markdown, selection, grownUnit, busy, model, height, onHide, onHeight, onAdd, onFiles, onSaveComments, onDetach, onConfirm, onRead, onAcceptNew, onLines, onVerify, folder, onPickFolder, onUseFolderFile, onCloseFolder, onCheck, canSearch, candidates, onFindSources, onUseCandidate, onDismissCandidates }: Props): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(false)
  const [pane, setPane] = useState<DockPane>('comments')
  const [text, setText] = useState('')
  const [over, setOver] = useState(false)
  const picker = useRef<HTMLInputElement | null>(null)
  const [fileQuery, setFileQuery] = useState('')
  const kind: NoteKind = pane === 'sources' ? 'source' : 'comment'
  const unit = selection ? textUnitAt(markdown, selection.start, selection.end) : undefined
  const claims = unit ? claimsInRange(meta, unit) : []
  /** What the box is about, whichever tab is open: the unit picked with Select more, the sentence under the cursor, or a phrase picked out by hand. */
  const unitLabel = grownUnit ? grownUnit[0].toUpperCase() + grownUnit.slice(1) : selection && selection.start === selection.end ? 'Sentence' : 'Selected text'
  const comments = unit ? commentsInRange(meta, unit) : []
  const open = comments.filter((c) => c.state === 'open')
  const [commentText, setCommentText] = useState('')
  const shownKey = `${unit?.start ?? -1}:${open.map((c) => `${c.id}=${c.text}`).join('|')}`
  useEffect(() => { setCommentText(commentsToText(open.map((c) => c.text))) }, [shownKey]) // eslint-disable-line react-hooks/exhaustive-deps
  function saveComments(): void {
    const changes = commentChanges(open, commentText)
    if (changes.edit.length > 0 || changes.add.length > 0 || changes.remove.length > 0) onSaveComments(changes)
  }

  function submit(): void {
    const t = text.trim()
    if (!t || !unit) return
    onAdd(kind, t)
    setText('')
  }

  const dockRef = useRef<HTMLElement | null>(null)
  return (
    <section
      ref={dockRef}
      className={`write__dock ${over ? 'is-over' : ''}`}
      style={height ? { height, maxHeight: '85%' } : undefined}
      aria-label="Comments and sources for this text"
      onDragOver={(e) => { e.preventDefault(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const files = Array.from(e.dataTransfer.files); if (files.length > 0) onFiles(files) }}
    >
      <Splitter label="Height of the box under the text" axis="y" grow={-1} className="write__split--dock" measure={() => dockRef.current?.getBoundingClientRect().height ?? 200} limits={() => ({ min: 96, max: Math.round((dockRef.current?.parentElement?.clientHeight ?? 600) * 0.85) })} onSize={onHeight} onReset={() => onHeight(undefined)} />
      <button type="button" className="write__dockchev" aria-label="Hide the box under the text" title="Hide the box under the text" onClick={onHide}>⌄</button>
      <button type="button" className="write__dockhead" onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed} title={collapsed ? 'Show' : 'Hide'}>
        <strong>{unit ? unitLabel : 'This text'}</strong>
        <span className="write__dockfor">{unit ? <>“{clip(unit.quote, 90)}”</> : 'Click in the text, or highlight some, to comment or add a source'}</span>
      </button>
      <div className="write__docktabs" role="tablist" aria-label="What to show about this text">
        {PANES.map((x) => (
          <button key={x.id} type="button" role="tab" aria-selected={pane === x.id} className={pane === x.id ? 'is-on' : ''} onClick={() => { setPane(x.id); setCollapsed(false) }}>
            {x.label}{x.id === 'issues' && issuesCount > 0 && <span className="write__badge">{issuesCount}</span>}
          </button>
        ))}
      </div>
      {!collapsed && pane === 'issues' && <div className="write__dockbody"><div className="write__dockscroll" role="tabpanel" aria-label="Issues">{issues}</div></div>}
      {!collapsed && pane === 'links' && <div className="write__dockbody"><div className="write__dockscroll" role="tabpanel" aria-label="Links">{links}</div></div>}
      {!collapsed && pane === 'history' && <div className="write__dockbody"><div className="write__dockscroll" role="tabpanel" aria-label="History of this text">{history}</div></div>}
      {!collapsed && !unit && (pane === 'comments' || pane === 'sources') && (
        <div className="write__dockbody"><div className="write__dockscroll" role="tabpanel" aria-label={pane === 'comments' ? 'Comments of this text' : 'Sources of this text'}><p className="write__muted">Click in the text, or highlight some, to see {pane === 'comments' ? 'the comments on it and to add one.' : 'the sources for it and to add one. The Sources button at the side lists every source of the article.'}</p></div></div>
      )}
      {!collapsed && unit && (pane === 'comments' || pane === 'sources') && (
        <div className="write__dockbody">
          <div className="write__dockscroll">
            {pane === 'comments' && (
              <>
                <textarea
                  aria-label="Comments on this text"
                  className="write__commenttext"
                  value={commentText}
                  disabled={!unit}
                  placeholder={unit ? 'Write comments on this text. Leave a blank line between one comment and the next.' : 'Click in the text first'}
                  onChange={(e) => setCommentText(e.target.value)}
                  onBlur={saveComments}
                />
                {comments.filter((c) => c.state !== 'open').length > 0 && (
                  <ul className="write__rows" aria-label="Comments dealt with">
                    {comments.filter((c) => c.state !== 'open').map((c) => (
                      <li key={c.id}>
                        <span className="write__rowicon" title="Comment"><Icon d={ICON_PATHS.comment} size={16} /></span>
                        <div className="write__rowmain">{c.text} <span className="write__badge">{c.state}</span></div>
                        <span className="write__rowacts"><IconButton label="Delete the comment" icon="close" onClick={() => onSaveComments({ edit: [], add: [], remove: [c.id] })} /></span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
            {pane === 'sources' && unit && claims.length === 0 && <p className="write__muted">Nothing here yet.</p>}
            <ul className="write__rows">
              {pane === 'sources' && claims.map((c) => {
                const srcs = sourcesForClaim(meta, c.id)
                const status = effectiveSourceStatus(c, meta.sources)
                return (
                  <li key={c.id} className="write__claimrow">
                    <span className="write__rowicon" title="Claim"><Icon d={ICON_PATHS.source} size={16} /></span>
                    <div className="write__rowmain">
                      {c.quote.trim() !== unit?.quote.trim() && <><span>{clip(c.quote, 120)}</span>{' '}</>}<span className={`write__badge write__badge--${status}`}>{STATUS_LABEL[status] ?? status}</span>
                      {srcs.length === 0 && <div className="write__reason">{lookupNote(c, false) ?? 'No source yet.'}</div>}
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
                    <span className="write__rowacts">{canSearch && <IconButton label="Find sources for this claim" icon="view" onClick={() => onFindSources(c.id)} disabled={busy} />}{srcs.length === 0 && canSearch ? <IconButton label="Look for a source and check this claim" icon="check2" onClick={() => onVerify(c.id)} disabled={busy} /> : <IconButton label={`Check this claim with ${model}`} icon="check2" onClick={() => onCheck(c.id)} disabled={busy || srcs.length === 0} />}</span>
                  </li>
                )
              })}
            </ul>
          </div>
          {pane === 'sources' && folder && (
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
          {pane === 'sources' && <div className="write__dockadd" role="group" aria-label="Add to this text">
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
          </div>}
        </div>
      )}
    </section>
  )
}
