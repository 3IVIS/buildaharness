import { MailIcon } from './mail-ui'

/** What the reader shows before a message is open. */
export function ReaderEmpty({ unread = 0 }: { unread?: number }): React.JSX.Element {
  return (
    <div className="reader-empty">
      <span className="reader-empty__icon" aria-hidden="true"><MailIcon name="mail" size={30} /></span>
      <h3>Select a message to read it</h3>
      <p>{unread > 0 ? `${unread} unread in this folder.` : 'Nothing unread here.'} Ask Aielia on the right to find, summarise or sort mail.</p>
    </div>
  )
}
