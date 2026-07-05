interface Props {
  reason: string
}

export function EscalationBanner({ reason }: Props): React.JSX.Element {
  return (
    <div className="escalation-banner">
      <div className="escalation-banner__title">Halted — needs your input</div>
      <div className="escalation-banner__reason">{reason}</div>
    </div>
  )
}
