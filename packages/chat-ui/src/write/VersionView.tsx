import type { VersionComparison } from '@buildaharness/aielia'

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
        {viewing.mode === 'view' ? 'An earlier version, read only.' : viewing.diff && viewing.diff.changedLines === 0 ? 'The text is the same as now.' : `${viewing.diff?.changedLines ?? 0} changed lines. Red was in that version, green is in the article now.`}{' '}
        <button type="button" className="write__link" onClick={() => onRestore(viewing.index)}>Restore this version</button>
      </p>
      {viewing.mode === 'view' ? (
        <pre className="write__pre">{viewing.markdown}</pre>
      ) : (
        <>
          <pre className="write__pre write__diff">{(viewing.diff?.text ?? []).filter((l) => l.type !== 'same').map((l, i) => <span key={i} className={`write__diff--${l.type}`}>{l.type === 'add' ? '+ ' : '- '}{l.text}{'\n'}</span>)}</pre>
          {(viewing.diff?.claims.length ?? 0) > 0 && <ul className="write__rows">{viewing.diff?.claims.map((c) => <li key={c.quote}><div className="write__rowmain">{c.quote}<div className="write__reason">{statusLabel[c.from] ?? 'not in the article'} → {statusLabel[c.to] ?? 'not in the article'}</div></div></li>)}</ul>}
          {(viewing.diff?.sources.length ?? 0) > 0 && <ul className="write__rows">{viewing.diff?.sources.map((x) => <li key={x.id}><div className="write__rowmain">Source {x.address ?? x.id}: {x.change}</div></li>)}</ul>}
        </>
      )}
    </div>
  )
}
