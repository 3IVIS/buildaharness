import { callTypeLabel } from '@buildaharness/aielia'

interface Props {
  usd: number
  /** Dollars and calls for each kind of call, biggest first. */
  byType: { id: string; usd: number; calls: number }[]
  hostName?: 'browser' | 'app'
}

/** What has been spent, always in the header; opening it says where it went. */
export function SpendBadge({ usd, byType, hostName = 'browser' }: Props): React.JSX.Element {
  return (
    <details className="write__spend">
      <summary title={`Spent so far in this ${hostName}`} aria-label={`Spent so far in this ${hostName}: $${usd.toFixed(2)}`}>${usd < 1 ? usd.toFixed(3) : usd.toFixed(2)}</summary>
      <div className="write__spendpop">
        <div className="write__muted">Spent so far in this {hostName}: ${usd.toFixed(2)}</div>
        {byType.length === 0 ? <div className="write__muted">Nothing yet.</div> : (
          <ul className="write__rows" aria-label="Spending by kind of call">
            {byType.map((t) => (
              <li key={t.id}><div className="write__rowmain">{callTypeLabel(t.id)}<div className="write__reason">${t.usd.toFixed(2)} · {t.calls} call{t.calls === 1 ? '' : 's'}</div></div></li>
            ))}
          </ul>
        )}
      </div>
    </details>
  )
}
