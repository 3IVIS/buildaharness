import type { MemorySummary, MemoryStatus, AuditEntry, MemoryWriteMode, ConsolidationProposal, SessionDigest } from '@buildaharness/aielia'
import { formatMemoryStatus } from '@buildaharness/aielia'

type Fact = MemorySummary['facts'][number]

/** Everything the panel shows, loaded by App.tsx through the shared PersonalAssistant methods (the same ones the CLI's /memory subcommands call). `null` = still loading. */
export interface MemoryPanelData {
  status: MemoryStatus
  summary: MemorySummary
  history: AuditEntry[]
  archive: Fact[]
  /** How many entries at the head of `archive` were set aside by staged forgetting (M5) and can be restored; the rest were replaced by a newer fact. */
  restorableCount?: number
  /** M5 consolidation proposals staged for the user (nothing in them has been applied). */
  proposals?: ConsolidationProposal[]
  /** M3 episodic digests (newest first). */
  digests?: SessionDigest[]
  /** Which optional writers are on; a control for a writer that is off is not shown, and nothing runs for it. */
  writers?: { reviewer: boolean; consolidation: boolean; digest: boolean }
}

interface Props {
  data: MemoryPanelData | null
  /** Result line of the last action ("✓ confirmed: …" / "✗ …"), shown above the lists. */
  message: string | null
  busy: boolean
  onConfirm: (selector: string) => void
  onReject: (selector: string) => void
  /** 1-based, same number `/memory forget <n>` takes. */
  /** `erase` also scrubs the fact's text from the audit log, so Undo can no longer restore it (CLI: `/memory forget <n> erase`). */
  onForget: (selector: string, erase?: boolean) => void
  onUndo: (seq: number) => void
  onForgetArchived: (selector: string) => void
  onConsolidate: () => void
  /** 1-based, same numbering as the CLI's `/memory consolidate accept|dismiss <n>`. */
  onAcceptProposal?: (selector: string) => void
  onDismissProposal?: (selector: string) => void
  /** 1-based over the archive list, same as `/memory archive restore <n>`. */
  onRestoreArchived?: (selector: string) => void
  /** Erase one digest by id, or all of them when omitted (`/memory forget digest [id]`). */
  onForgetDigests?: (id?: string) => void
  onSetEnabled: (enabled: boolean) => void
  onSetMode: (mode: MemoryWriteMode) => void
  onClose: () => void
}

const MODE_OPTIONS: { value: MemoryWriteMode; label: string }[] = [
  { value: 'staged', label: 'Staged: ask me before saving what is learned across turns' },
  { value: 'auto', label: 'Auto: save cross-turn learning directly' },
  { value: 'user_only', label: 'User only: never save anything I did not state myself without asking' },
]

/**
 * The GUI counterpart of the CLI's `/memory` family (M6 of plans/agent_memory_framework_plan.html):
 * pending queue confirm/reject, forget, history + undo, archive, consolidate, write mode, and
 * `/memory off`. It holds no memory logic of its own: every control calls a PersonalAssistant
 * method, the same one the CLI command calls. Before this panel existed, a browser user had no way
 * to confirm a staged write.
 */
export function MemoryPanel({ data, message, busy, onConfirm, onReject, onForget, onUndo, onForgetArchived, onConsolidate, onAcceptProposal, onDismissProposal, onRestoreArchived, onForgetDigests, onSetEnabled, onSetMode, onClose }: Props): React.JSX.Element {
  if (!data) {
    return (
      <div className="memory-panel">
        <header className="memory-panel__header"><button type="button" className="memory-panel__back" aria-label="Back to chat" onClick={onClose}>← Back</button><h2>Memory</h2></header>
        <p>Loading…</p>
      </div>
    )
  }
  const { status, summary, history, archive } = data
  const restorable = data.restorableCount ?? 0
  const proposals = data.proposals ?? []
  const digests = data.digests ?? []
  return (
    <div className="memory-panel">
      <header className="memory-panel__header">
        <button type="button" className="memory-panel__back" aria-label="Back to chat" onClick={onClose}>← Back</button>
        <h2>Memory</h2>
      </header>

      {message && <div className="memory-panel__message" role="status">{message}</div>}

      <section className="memory-panel__section" aria-label="Memory status">
        <pre className="memory-panel__status">{formatMemoryStatus(status)}</pre>
        <label className="memory-panel__field">
          <span>What may be saved</span>
          <select aria-label="Memory write mode" value={status.mode} disabled={busy} onChange={(e) => onSetMode(e.target.value as MemoryWriteMode)}>
            {MODE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <div className="memory-panel__actions">
          <button type="button" disabled={busy} onClick={() => onSetEnabled(status.off)}>
            {status.off ? 'Resume saving memory' : 'Stop saving memory'}
          </button>
          {(data.writers?.consolidation ?? true) && <button type="button" disabled={busy} onClick={onConsolidate}>Tidy memory</button>}
        </div>
      </section>

      <section className="memory-panel__section" aria-label="Waiting for your confirmation">
        <h3>Waiting for your confirmation ({summary.pending.length})</h3>
        {summary.pending.length === 0 ? <p>None.</p> : (
          <ol className="memory-panel__list">
            {summary.pending.map((f, i) => (
              <li key={`${f.text}|${f.extractedAt}`}>
                <span>{f.text}</span>
                {f.flagged && <span className="memory-panel__flag"> (flagged: reads like an instruction, review before confirming)</span>}
                {f.previouslyRejected && <span className="memory-panel__flag"> (previously rejected, restated)</span>}
                <button type="button" disabled={busy} aria-label={`Confirm pending ${i + 1}`} onClick={() => onConfirm(String(i + 1))}>Confirm</button>
                <button type="button" className="memory-panel__danger" disabled={busy} aria-label={`Reject pending ${i + 1}`} onClick={() => onReject(String(i + 1))}>Reject</button>
              </li>
            ))}
          </ol>
        )}
      </section>

      {proposals.length > 0 && (
        <section className="memory-panel__section" aria-label="Proposed tidy-ups">
          <h3>Proposed tidy-ups ({proposals.length}) — nothing changes until you accept</h3>
          <ol className="memory-panel__list">
            {proposals.map((p, i) => (
              <li key={p.id}>
                <span>[{p.kind}]{p.touchesUserAsserted ? ' (touches something you said yourself)' : ''} {p.text ? `-> "${p.text}" ` : ''}{p.reason}</span>
                {onAcceptProposal && <button type="button" disabled={busy} aria-label={`Accept proposal ${i + 1}`} onClick={() => onAcceptProposal(String(i + 1))}>Accept</button>}
                {onDismissProposal && <button type="button" disabled={busy} aria-label={`Dismiss proposal ${i + 1}`} onClick={() => onDismissProposal(String(i + 1))}>Dismiss</button>}
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="memory-panel__section" aria-label="Facts I know">
        <h3>Facts I know ({summary.facts.length})</h3>
        {summary.facts.length === 0 ? <p>None yet.</p> : (
          <ol className="memory-panel__list">
            {summary.facts.map((f, i) => (
              <li key={`${f.text}|${f.extractedAt}`}>
                <span>{f.text}</span>
                <button type="button" disabled={busy} aria-label={`Forget fact ${i + 1}`} onClick={() => onForget(String(i + 1))}>Forget</button>
                <button type="button" className="memory-panel__danger" disabled={busy} aria-label={`Erase fact ${i + 1} permanently`} title="Forget and remove from history, so it cannot be undone" onClick={() => onForget(String(i + 1), true)}>Erase</button>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="memory-panel__section" aria-label="History">
        <h3>History</h3>
        {history.length === 0 ? <p>No memory changes recorded (the audit log is empty or switched off).</p> : (
          <ol className="memory-panel__list" reversed>
            {[...history].reverse().map((e) => (
              <li key={e.seq}>
                <span>#{e.seq} {e.op} [{e.store}] {e.erased ? '(erased by you)' : (e.after ?? e.before)?.text ?? e.factId}</span>
                {e.op !== 'undo' && !e.erased && (
                  <button type="button" disabled={busy} aria-label={`Undo change ${e.seq}`} onClick={() => onUndo(e.seq)}>Undo</button>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="memory-panel__section" aria-label="Archive">
        <h3>Set aside or replaced ({archive.length})</h3>
        {archive.length === 0 ? <p>Empty.</p> : (
          <ol className="memory-panel__list">
            {archive.map((f, i) => (
              <li key={`${f.text}|${f.extractedAt}`}>
                <span>{f.text}</span>
                {i < restorable && onRestoreArchived && <button type="button" disabled={busy} aria-label={`Restore archived fact ${i + 1}`} onClick={() => onRestoreArchived(String(i + 1))}>Restore</button>}
                <button type="button" className="memory-panel__danger" disabled={busy} aria-label={`Erase archived fact ${i + 1}`} onClick={() => onForgetArchived(String(i + 1))}>Erase</button>
              </li>
            ))}
          </ol>
        )}
      </section>

      {digests.length > 0 && (
        <section className="memory-panel__section" aria-label="Session digests">
          <h3>Session digests ({digests.length})</h3>
          <ol className="memory-panel__list">
            {digests.map((d) => (
              <li key={d.sessionId}>
                <span>{d.createdAt.slice(0, 10)} {d.oneLine}</span>
                {onForgetDigests && <button type="button" disabled={busy} aria-label={`Forget digest ${d.sessionId}`} onClick={() => onForgetDigests(d.sessionId)}>Forget</button>}
              </li>
            ))}
          </ol>
          {onForgetDigests && <button type="button" disabled={busy} onClick={() => onForgetDigests()}>Forget all digests</button>}
        </section>
      )}
    </div>
  )
}
