interface Props {
  reason: string
  onRetry?: () => void
}

export function EscalationBanner({ reason, onRetry }: Props): React.JSX.Element {
  return (
    <div className="escalation-banner">
      <div className="escalation-banner__title">Halted — needs your input</div>
      <div className="escalation-banner__reason">{reason}</div>
      {onRetry && (
        <button type="button" className="escalation-banner__retry" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  )
}
