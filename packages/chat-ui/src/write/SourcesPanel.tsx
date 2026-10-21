import type { ArticleMeta, Source } from '@buildaharness/aielia'
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

/** Every source of the article, and the claims each one backs. The box under the text shows the sources of the selected text only. */
export function SourcesPanel({ meta, busy, onJump, onRead, onAcceptNew }: Props): React.JSX.Element {
  if (meta.sources.length === 0) return <p className="write__muted">No sources yet. Click in the text and add one under it, or drop a file in the chat.</p>
  return (
    <ul className="write__rows" aria-label="All sources of the article">
      {meta.sources.map((s) => {
        const backs = meta.links
          .filter((l) => l.kind === 'supported_by' && l.from.type === 'claim' && l.to.type === 'source' && l.to.id === s.id)
          .map((l) => ({ link: l, claim: meta.claims.find((c) => c.id === l.from.id) }))
          .filter((x): x is { link: typeof x.link; claim: NonNullable<typeof x.claim> } => x.claim !== undefined)
        const canRead = (s.kind === 'web' || s.kind === 'code') && s.address !== undefined && /^https?:/.test(s.address)
        return (
          <li key={s.id}>
            <div className="write__rowmain">
              <div className="write__hline">
                {s.kind !== 'say_so' && s.address !== undefined ? (
                  <span className="write__srcname" title={s.address}>
                    <span className="write__srcfile">{splitAddress(s.address).name}</span>
                    <span className="write__srcdir">{splitAddress(s.address).dir}</span>
                  </span>
                ) : (
                  <span className="write__srcfile" title={nameOf(s)}>{nameOf(s)}</span>
                )}
                <span className="write__badge">{KIND_LABEL[s.kind]}</span>
                {s.kind !== 'say_so' && <span className="write__badge">{FRESHNESS_LABEL[s.freshness]}</span>}
                {s.lines && <span className="write__badge">lines {s.lines.from}–{s.lines.to}</span>}
              </div>
              {s.fetchedPassage && <div className="write__reason">{s.kind === 'code' ? 'The file has changed since you read it.' : 'The page has changed since you read it.'}</div>}
              {backs.length === 0 ? <div className="write__reason">Not backing any claim yet.</div> : (
                <ul className="write__srcclaims" aria-label="Claims this source backs">
                  {backs.map(({ link, claim }) => (
                    <li key={link.id}>
                      <button type="button" className="write__link" onClick={() => onJump(claim.position)}>{clip(claim.quote, 90)}</button>
                      {link.origin === 'proposed' && <span className="write__badge">suggested</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <span className="write__rowacts">
              {canRead && <IconButton label={s.passage ? 'Read the page again' : 'Read the page'} icon="restore" onClick={() => onRead(s.id)} disabled={busy} />}
              {s.fetchedPassage && <IconButton label="Use the new text of this source" icon="check2" onClick={() => onAcceptNew(s.id)} />}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
