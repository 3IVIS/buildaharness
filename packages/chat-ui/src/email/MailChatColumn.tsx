import { chipKey, chipLabel, type BulkPreview, type MailChip, type MailActionRecord } from '@buildaharness/aielia'
import { SpendBadge } from '../shared-ui/SpendBadge'

/** A mail job running in the chat: what it is doing and how far (a counted job shows done of total). */
export interface MailJobProgress { label: string; stage: string; count?: readonly [number, number]; stopping?: boolean }

export interface ChatColumnLine { id: number; from: 'you' | 'aielia'; text: string }

interface Props {
  lines: ChatColumnLine[]
  chips: MailChip[]
  onRemoveChip: (key: string) => void
  input: string
  onInput: (v: string) => void
  onSend: () => void
  busy: boolean
  /** Mail job in progress; the Stop button shows only while there is one. */
  progress?: MailJobProgress | null
  onStop?: () => void
  spend: { usd: number; tokens?: number; byType: { id: string; usd: number; calls: number }[] }
  /** A change Aielia proposes, shown before it is applied. */
  preview?: BulkPreview | null
  onApplyPreview?: () => void
  onCancelPreview?: () => void
  /** The latest applied change, with a way to take it back. */
  lastAction?: MailActionRecord | null
  onUndo?: () => void
}

/** The Aielia column of Email: context chips, the work-progress block, Stop, the spend badge, previews of changes and undo. It never offers files or a shell. */
export function MailChatColumn(p: Props): React.JSX.Element {
  return (
    <section className="email-chat" aria-label="Aielia">
      <ul className="email-chat__lines" aria-live="polite">
        {p.lines.map((l) => <li key={l.id} data-from={l.from}>{l.text}</li>)}
      </ul>
      {p.progress && (
        <div className="email-chat__progress" role="status">
          <span>{p.progress.label}: {p.progress.stopping ? 'stopping after this step' : p.progress.stage}</span>
          {p.progress.count && <span> ({p.progress.count[0]} of {p.progress.count[1]})</span>}
          {p.onStop && <button type="button" onClick={p.onStop} disabled={p.progress.stopping}>Stop</button>}
        </div>
      )}
      {p.preview && (
        <div className="email-chat__preview" role="group" aria-label="Preview of the change">
          <p>{p.preview.rows.length} message{p.preview.rows.length === 1 ? '' : 's'} would change{p.preview.overCeiling ? ' (more than can be done in one go)' : ''}.</p>
          <ul>{p.preview.rows.slice(0, 5).map((r) => <li key={r.messageId}>{r.subject}</li>)}</ul>
          <button type="button" onClick={p.onApplyPreview} disabled={p.preview.overCeiling || p.preview.rows.length === 0}>Apply</button>
          <button type="button" onClick={p.onCancelPreview}>Cancel</button>
        </div>
      )}
      {p.lastAction && !p.lastAction.undoneAt && (
        <div className="email-chat__undo" role="status">
          <span>Done: {p.lastAction.entries.length} message{p.lastAction.entries.length === 1 ? '' : 's'} changed.</span>
          <button type="button" onClick={p.onUndo}>Undo</button>
        </div>
      )}
      <ul className="email-chat__chips" aria-label="What Aielia is looking at">
        {p.chips.map((c) => (
          <li key={chipKey(c)}>{chipLabel(c)} <button type="button" aria-label={`Remove: ${chipLabel(c)}`} onClick={() => p.onRemoveChip(chipKey(c))}>×</button></li>
        ))}
        {p.chips.length === 0 && <li className="email-chat__nochips">No message selected: Aielia has no "this one" yet.</li>}
      </ul>
      <div className="email-chat__input">
        <input aria-label="Ask Aielia" value={p.input} disabled={p.busy} onChange={(e) => p.onInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') p.onSend() }} />
        <button type="button" onClick={p.onSend} disabled={p.busy || !p.input.trim()}>Send</button>
        <SpendBadge usd={p.spend.usd} tokens={p.spend.tokens} byType={p.spend.byType} />
      </div>
    </section>
  )
}
