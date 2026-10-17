/** A small "?" that explains on hover or keyboard focus, so a screen can say less and keep the explanation one touch away. */
export function Hint({ text }: { text: string }): React.JSX.Element {
  return <span className="write__hint" tabIndex={0} role="img" aria-label={text} data-tip={text}>?</span>
}
