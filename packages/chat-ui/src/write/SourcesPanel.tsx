import { useState } from 'react'
import type { ArticleMeta, Claim, Link, Source } from '@buildaharness/aielia'
import { IconButton } from './icons'

interface Props {
  meta: ArticleMeta
  busy: boolean
  /** Moves the cursor in the text to a claim a source backs. */
  onJump(position: number): void
  onRead(sourceId: string): void
  onAcceptNew(sourceId: string): void
}

const clip = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n)}…` : t)
const KIND_LABEL: Record<Source['kind'], string> = { web: 'web page', code: 'code', document: 'document', upload: 'passage', say_so: 'your word' }
const FRESHNESS_LABEL: Record<Source['freshness'], string> = { unchecked: 'not read yet', current: 'current', changed: 'changed', unreachable: 'could not be reached' }

const nameOf = (s: Source): string => (s.kind === 'say_so' ? 'Your word' : s.address ?? (s.passage ? clip(s.passage.trim().replace(/\s+/g, ' '), 60) : KIND_LABEL[s.kind]))

/** An address split into its last segment (the name) and what comes before it (the path, shown only as far as there is room). */
export function splitAddress(address: string): { name: string; dir: string } {
  const bare = address.replace(/[?#].*$/, '').replace(/\/+$/, '')
  const i = bare.lastIndexOf('/')
  const name = i === -1 || i === bare.length - 1 ? bare : bare.slice(i + 1)
  return { name: name || address, dir: i > 0 ? bare.slice(0, i + 1) : '' }
}

export interface SourceMapping {
  link: Link
  claim: Claim
  source: Source
}

export interface SourceGroup {
  key: string
  /** The shared address, when the sources are parts of one file or page. */
  address?: string
  sources: Source[]
  mappings: SourceMapping[]
  /** How many different claims the file backs. */
  claimCount: number
}

/** Sources of one file (or page) are one group; a source without an address is its own group. */
export function groupSources(meta: ArticleMeta): SourceGroup[] {
  const groups = new Map<string, SourceGroup>()
  for (const source of meta.sources) {
    const key = source.kind !== 'say_so' && source.address !== undefined ? `a:${source.address}` : `s:${source.id}`
    const g = groups.get(key) ?? { key, address: key.startsWith('a:') ? source.address : undefined, sources: [], mappings: [], claimCount: 0 }
    g.sources.push(source)
    for (const link of meta.links) {
      if (link.kind !== 'supported_by' || link.from.type !== 'claim' || link.to.type !== 'source' || link.to.id !== source.id) continue
      const claim = meta.claims.find((c) => c.id === link.from.id)
      if (claim) g.mappings.push({ link, claim, source })
    }
    groups.set(key, g)
  }
  for (const g of groups.values()) {
    g.mappings.sort((a, b) => a.claim.position - b.claim.position)
    g.claimCount = new Set(g.mappings.map((m) => m.claim.id)).size
  }
  return [...groups.values()]
}

/**
 * The lines of a code source that back a claim. The passage of a file found by search carries a few lines of context on each side, and the
 * lines it was found at are only in its note, so the context is cut away when the note says where the lines are.
 */
export function codeLinesOf(s: Source): { from?: number; to?: number; text: string } {
  const passage = (s.passage ?? '').replace(/\s+$/, '')
  if (s.lines) return { from: s.lines.from, to: s.lines.to, text: passage }
  const m = /\(lines (\d+)-(\d+)\)/.exec(s.note ?? '')
  if (!m || !passage) return { text: passage }
  const from = Number(m[1])
  const to = Number(m[2])
  const lines = passage.split('\n')
  const offset = from - Math.max(1, from - 3)
  const cut = lines.slice(offset, offset + (to - from + 1)).join('\n')
  return { from, to, text: cut.trim() ? cut : passage }
}

const oneLine = (t: string): string => t.replace(/\s+/g, ' ').trim()
const hoverText = (t: string): string => clip(t, 1500)

/** Every source of the article by file, with how many claims each file backs; opening a file lists the code lines and the claims they back, side by side. */
export function SourcesPanel({ meta, busy, onJump, onRead, onAcceptNew }: Props): React.JSX.Element {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  if (meta.sources.length === 0) return <p className="write__muted">No sources yet. Click in the text and add one under it, or drop a file in the chat.</p>
  const toggle = (key: string): void => setOpen((o) => { const n = new Set(o); if (!n.delete(key)) n.add(key); return n })
  return (
    <ul className="write__rows" aria-label="All sources of the article">
      {groupSources(meta).map((g) => {
        const first = g.sources[0]
        const readable = g.sources.filter((s) => (s.kind === 'web' || s.kind === 'code') && s.address !== undefined && /^https?:/.test(s.address))
        const changed = g.sources.filter((s) => s.fetchedPassage)
        const isOpen = open.has(g.key)
        const kinds = [...new Set(g.sources.map((s) => KIND_LABEL[s.kind]))]
        const freshness = [...new Set(g.sources.filter((s) => s.kind !== 'say_so').map((s) => FRESHNESS_LABEL[s.freshness]))]
        return (
          <li key={g.key}>
            <div className="write__rowmain">
              <div className="write__hline">
                {g.address !== undefined ? (
                  <span className="write__srcname" title={g.address}>
                    <span className="write__srcfile">{splitAddress(g.address).name}</span>
                    <span className="write__srcdir">{splitAddress(g.address).dir}</span>
                  </span>
                ) : (
                  <span className="write__srcfile" title={nameOf(first)}>{nameOf(first)}</span>
                )}
                {kinds.map((k) => <span key={k} className="write__badge">{k}</span>)}
                {freshness.map((f) => <span key={f} className="write__badge">{f}</span>)}
                <button type="button" className="write__badge write__srccount" aria-expanded={isOpen} disabled={g.mappings.length === 0} onClick={() => toggle(g.key)}>
                  {g.claimCount === 0 ? 'no claims yet' : `${g.claimCount} claim${g.claimCount === 1 ? '' : 's'}`}
                </button>
              </div>
              {changed.length > 0 && <div className="write__reason">{first.kind === 'code' ? 'The file has changed since you read it.' : 'The page has changed since you read it.'}</div>}
              {isOpen && (
                <ul className="write__srcmap" aria-label="Lines of this file and the claims they back">
                  {g.mappings.map(({ link, claim, source }) => {
                    const code = codeLinesOf(source)
                    const codeLine = oneLine(code.text.split('\n').find((l) => l.trim()) ?? '')
                    return (
                      <li key={link.id}>
                        <div className="write__srcline" title={hoverText(code.text)}>
                          {code.from !== undefined && <span className="write__srclines">{code.from === code.to ? code.from : `${code.from}–${code.to}`}</span>}
                          <code>{codeLine || '(no text kept)'}</code>
                        </div>
                        <div className="write__srcclaim">
                          <span aria-hidden="true">↳</span>
                          <button type="button" className="write__link" title={hoverText(claim.quote)} onClick={() => onJump(claim.position)}>{oneLine(claim.quote)}</button>
                          {link.origin === 'proposed' && <span className="write__badge">suggested</span>}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
            <span className="write__rowacts">
              {readable.length > 0 && <IconButton label={readable.some((s) => s.passage) ? 'Read the page again' : 'Read the page'} icon="restore" onClick={() => readable.forEach((s) => onRead(s.id))} disabled={busy} />}
              {changed.length > 0 && <IconButton label="Use the new text of this source" icon="check2" onClick={() => changed.forEach((s) => onAcceptNew(s.id))} />}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
