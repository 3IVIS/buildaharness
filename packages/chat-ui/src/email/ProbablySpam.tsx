export interface SpamItem { threadId: string; subject: string; sender: string; reason: string }

interface Props {
  items: readonly SpamItem[]
  /** Move all of them to Junk. The host shows its own preview and undo; this only asks. */
  onMoveAll: () => void
  /** The user says this one is not spam: the host pins it so no later pass changes it. */
  onNotSpam: (threadId: string) => void
  /** Set when this mailbox is read-only: the move button is replaced by this note, and "Not spam" is not offered (nothing is stored). */
  readOnlyNote?: string
}

/** The "Probably spam" group above the list: what Aielia thinks is junk and why. One action for the group, one escape for each item. Nothing moves by itself. */
export function ProbablySpam({ items, onMoveAll, onNotSpam, readOnlyNote }: Props): React.JSX.Element | null {
  if (items.length === 0) return null
  return (
    <details className="probably-spam">
      <summary>
        <span>{items.length} probably spam</span>
        {readOnlyNote
          ? <span className="probably-spam__why">{readOnlyNote}</span>
          : <button type="button" className="probably-spam__move" onClick={(e) => { e.preventDefault(); onMoveAll() }}>Move to Junk</button>}
      </summary>
      <ul>
        {items.map((i) => (
          <li key={i.threadId}>
            <span className="probably-spam__subject">{i.subject}</span>
            <span className="probably-spam__from">{i.sender}</span>
            <span className="probably-spam__why">{i.reason}</span>
            {!readOnlyNote && <button type="button" aria-label={`Not spam: ${i.subject}`} onClick={() => onNotSpam(i.threadId)}>Not spam</button>}
          </li>
        ))}
      </ul>
    </details>
  )
}
