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

export function ApprovalCard({ pendingMessage, reason, riskLevel, pendingActionKind, resolution, illustrative, onApprove, onDeny }: Props): React.JSX.Element {
  const label = pendingActionKind ? KIND_LABELS[pendingActionKind] : riskLevel
  return (
    <div className="approval-card">
      <div className="approval-card__header">
        Needs approval{label ? ` — ${label}` : ''}
      </div>
      <blockquote className="approval-card__pending">{pendingMessage}</blockquote>
      <div className="approval-card__reason">{reason}</div>
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
