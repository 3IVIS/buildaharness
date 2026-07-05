interface Props {
  pendingMessage: string
  reason: string
  riskLevel?: string
  resolution?: 'approved' | 'denied'
  onApprove: () => void
  onDeny: () => void
}

export function ApprovalCard({ pendingMessage, reason, riskLevel, resolution, onApprove, onDeny }: Props): React.JSX.Element {
  return (
    <div className="approval-card">
      <div className="approval-card__header">
        Needs approval{riskLevel ? ` — ${riskLevel}` : ''}
      </div>
      <blockquote className="approval-card__pending">{pendingMessage}</blockquote>
      <div className="approval-card__reason">{reason}</div>
      {resolution ? (
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
