interface Props {
  pendingMessage: string
  reason: string
  riskLevel?: string
  /** A staged write_file/run_shell_command/send_email/batch-research action's kind — see ChatEntry's
   * 'approval' doc comment. Takes precedence over riskLevel for the header label, mirroring
   * cli.ts's own kindLabel ternary for the same pause. */
  pendingActionKind?: 'write' | 'shell' | 'email' | 'batch' | 'revert'
  resolution?: 'approved' | 'denied'
  /** Read-only sample (the /try first-load demo): render an explanatory line instead of
   * live Approve/Deny buttons — a visitor with no key configured can't actually resolve it. */
  illustrative?: boolean
  onApprove: () => void
  onDeny: () => void
}

const KIND_LABELS: Record<string, string> = { write: 'write', shell: 'shell command', email: 'send email', batch: 'batch research', revert: 'revert' }

/** A staged action's reason is "<headline>\n<detail>": the headline names the action, the detail is the exact content (new-file text or a numbered diff), the command's cwd, or an email's fields. */
function splitReason(reason: string): { headline: string; detail: string | null } {
  const newline = reason.indexOf('\n')
  if (newline === -1) return { headline: reason, detail: null }
  const detail = reason.slice(newline + 1).replace(/\s+$/, '')
  return { headline: reason.slice(0, newline), detail: detail === '' ? null : detail }
}

// Numbered diff rows from formatWriteDiff look like "  12 +added" / "  12 -removed".
const DIFF_ROW = /^\s*\d+ ([+-])/

export function ApprovalCard({ pendingMessage, reason, riskLevel, pendingActionKind, resolution, illustrative, onApprove, onDeny }: Props): React.JSX.Element {
  const { headline, detail } = splitReason(reason)
  const label = pendingActionKind ? KIND_LABELS[pendingActionKind] : riskLevel
  return (
    <div className="approval-card">
      <div className="approval-card__header">
        Needs approval{label ? ` — ${label}` : ''}
      </div>
      <blockquote className="approval-card__pending">{pendingMessage}</blockquote>
      <div className="approval-card__reason">{headline}</div>
      {detail !== null && (
        <pre className="approval-card__detail" aria-label="Exact change">
          {detail.split('\n').map((line, i) => {
            const sign = DIFF_ROW.exec(line)?.[1]
            return <span key={i} className={sign === '+' ? 'approval-card__line--add' : sign === '-' ? 'approval-card__line--del' : undefined}>{line}{'\n'}</span>
          })}
        </pre>
      )}
      {illustrative ? (
        <div className="approval-card__resolution">
          This is a sample. Add a model in Settings (⚙) and send your own message — a real
          high-risk request pauses here before Aielia makes any model call.
        </div>
      ) : resolution ? (
        <div className="approval-card__resolution">{resolution === 'approved' ? 'Approved.' : 'Denied.'}</div>
      ) : (
        <div className="approval-card__actions">
          <button type="button" onClick={onApprove}>Approve</button>
          <button type="button" className="approval-card__deny" onClick={onDeny}>Deny</button>
        </div>
      )}
    </div>
  )
}
