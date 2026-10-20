import type { ChangeSummary } from '@buildaharness/aielia'
import { EditableText } from './EditableText'
import { Hint } from './Hint'
import { ICON_PATHS, Icon, IconButton } from './icons'

export interface VersionRow {
  index: number
  kind: 'published' | 'checkpoint'
  label?: string
  at: string
  change: ChangeSummary
}

interface Props {
  versions: VersionRow[]
  working: ChangeSummary | undefined
  busy: boolean
  onSave(): void
  onView(index: number): void
  onCompare(index: number): void
  onRestore(index: number): void
  onRename(index: number, label: string): void
}

/** One line saying what a version changed: lines, then the sections, claims and sources it touched. */
export function describeChange(c: ChangeSummary | undefined): string {
  if (!c) return 'Nothing saved yet'
  if (c.first) return 'First version'
  const parts: string[] = [c.added === 0 && c.removed === 0 ? 'No text changes' : `+${c.added} −${c.removed} lines`]
  if (c.sections.length > 0) parts.push(c.sections.length <= 3 ? c.sections.join(', ') : `${c.sections.slice(0, 3).join(', ')} and ${c.sections.length - 3} more`)
  if (c.claims > 0) parts.push(`${c.claims} claim${c.claims === 1 ? '' : 's'}`)
  if (c.sources > 0) parts.push(`${c.sources} source${c.sources === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

export function HistoryPanel({ versions, working, busy, onSave, onView, onCompare, onRestore, onRename }: Props): React.JSX.Element {
  return (
    <>
      <h2 className="write__panehead">History</h2>
      <ul className="write__legend" aria-label="What the icons do">
        <li><Icon d={ICON_PATHS.view} /> View the text</li>
        <li><Icon d={ICON_PATHS.compare} /> Compare with now</li>
        <li><Icon d={ICON_PATHS.restore} /> Restore</li>
      </ul>
      <div className="write__working">
        <div>
          <strong>Now</strong>
          <div className="write__hchange">{working ? (working.added === 0 && working.removed === 0 ? 'No text changes since the last version' : `${describeChange(working)} since the last version`) : 'Nothing saved yet'}</div>
        </div>
        <button type="button" onClick={onSave} disabled={busy}><Icon d={ICON_PATHS.save} /> Save version</button>
      </div>
      <ul className="write__history">
        {versions.map((v) => (
          <li key={v.index}>
            <span className="write__hkind" title={v.kind === 'published' ? 'Published (frozen)' : 'Saved'}><Icon d={v.kind === 'published' ? ICON_PATHS.published : ICON_PATHS.saved} /></span>
            <div className="write__hmain">
              <div className="write__hline">
                {v.kind === 'published' ? <strong>{v.label ?? 'Published'}</strong> : <strong><EditableText label="Version name" value={v.label ?? 'Saved'} onSave={(t) => onRename(v.index, t)} /></strong>}
                <time dateTime={v.at}>{new Date(v.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time>
              </div>
              <div className="write__hchange">{describeChange(v.change)}</div>
            </div>
            <div className="write__hactions">
              <IconButton label="View" icon="view" onClick={() => onView(v.index)} />
              <IconButton label="Compare with now" icon="compare" onClick={() => onCompare(v.index)} />
              <IconButton label="Restore" icon="restore" onClick={() => onRestore(v.index)} />
            </div>
          </li>
        ))}
      </ul>
      {versions.length === 0 && <p className="write__muted">No saved versions yet.<Hint text="A version is saved before a large change or a suggestion you accept, and when you press Save version." /></p>}
    </>
  )
}
