interface Props {
  role: 'user' | 'assistant' | 'error'
  content: string
}

export function ChatMessageBubble({ role, content }: Props): React.JSX.Element {
  return (
    <div className={`bubble bubble--${role}`}>
      <div className="bubble__role">{role === 'user' ? 'You' : role === 'assistant' ? 'Assistant' : 'Error'}</div>
      <div className="bubble__content">{content}</div>
    </div>
  )
}
