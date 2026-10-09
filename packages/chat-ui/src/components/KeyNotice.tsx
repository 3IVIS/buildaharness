interface Props {
  /** Opens the key setup (the same wizard first-run uses). */
  onAddKey: () => void
}

/**
 * Shown on the hosted browser trial until the visitor has added their own AI key. The page
 * underneath is a sample chat, so without this a first-time visitor can't tell that nothing
 * will answer until they bring a key.
 */
export function KeyNotice({ onAddKey }: Props): React.JSX.Element {
  return (
    <div className="key-notice" role="note">
      <div className="key-notice__text">
        <strong>Bring your own AI key to chat.</strong>
        <span>
          Aielia has no account of its own. Add a key from Anthropic, OpenAI or OpenRouter to start; it stays in this browser.
        </span>
      </div>
      <button type="button" className="key-notice__button" onClick={onAddKey}>Add your key</button>
    </div>
  )
}
