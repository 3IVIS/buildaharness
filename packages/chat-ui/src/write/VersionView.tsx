import { diffForDisplay, outlineToText, type VersionComparison } from '@buildaharness/aielia'

export interface Viewing {
  mode: 'view' | 'compare'
  index: number
  markdown: string
  diff?: VersionComparison
}

interface Props {
  viewing: Viewing
  statusLabel: Record<string, string>
  onRestore(index: number): void
}

/** An earlier version in the main text window: its text, or what changed between it and the article now. Read only; "Current" in the toggle goes back to the article. */
export function VersionView({ viewing, statusLabel, onRestore }: Props): React.JSX.Element {
  return (
    <div className="write__versionview" aria-label="Version detail">
      <p className="write__muted">
        {viewing.mode === 'view' ? 'An earlier version, read only.' : viewing.diff && viewing.diff.changedLines === 0 ? 'The text is the same as now.' : `${viewing.diff?.changedLines ?? 0} changed lines. Red was in that version and is gone, green is in the article now.`}{' '}
        <button type="button" className="write__link" onClick={() => onRestore(viewing.index)}>Restore this version</button>
      </p>
      {viewing.mode === 'view' ? (
        <pre className="write__pre">{viewing.markdown}</pre>
      ) : (
        <>
          <div className="write__pre write__diff" role="group" aria-label="Changes">
            {diffForDisplay(viewing.diff?.text ?? []).map((l, i) => (
              <div key={i} className={`write__diffline write__diffline--${l.type}`}>
                {l.type === 'change'
                  ? l.parts.map((p, k) => (p.type === 'same' ? <span key={k}>{p.text}</span> : p.type === 'del' ? <del key={k} className="write__diff--del">{p.text}</del> : <ins key={k} className="write__diff--add">{p.text}</ins>))
                  : l.text}
              </div>
            ))}
          </div>
          {(viewing.diff?.claims.length ?? 0) > 0 && <ul className="write__rows">{viewing.diff?.claims.map((c) => <li key={c.quote}><div className="write__rowmain">{c.quote}<div className="write__reason">{statusLabel[c.from] ?? 'not in the article'} → {statusLabel[c.to] ?? 'not in the article'}</div></div></li>)}</ul>}
          {(viewing.diff?.sources.length ?? 0) > 0 && <ul className="write__rows">{viewing.diff?.sources.map((x) => <li key={x.id}><div className="write__rowmain">Source {x.address ?? x.id}: {x.change}</div></li>)}</ul>}
        </>
      )}
    </div>
  )
}

/** The outline of an earlier version, read only: one heading per line, the way the outline of the article is written. */
export function VersionOutline({ viewing, onRestore }: { viewing: Viewing; onRestore(index: number): void }): React.JSX.Element {
  const text = outlineToText(viewing.markdown)
  return (
    <div className="write__versionview" aria-label="Version outline">
      <p className="write__muted">
        The outline of an earlier version, read only.{' '}
        <button type="button" className="write__link" onClick={() => onRestore(viewing.index)}>Restore this version</button>
      </p>
      {text ? <pre className="write__pre">{text}</pre> : <p className="write__muted">That version has no headings.</p>}
    </div>
  )
}
