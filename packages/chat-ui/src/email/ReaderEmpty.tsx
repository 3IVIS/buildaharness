import { MailIcon, type MAIL_ICONS } from './mail-ui'

/** An empty pane: a round icon, a title and a sentence of what will appear here. */
export function EmptyState({ icon, title, text }: { icon: keyof typeof MAIL_ICONS; title: string; text: string }): React.JSX.Element {
  return (
    <div className="reader-empty">
      <span className="reader-empty__icon" aria-hidden="true"><MailIcon name={icon} size={30} /></span>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  )
}

/** What the reader shows before a message is open. */
export function ReaderEmpty({ unread = 0 }: { unread?: number }): React.JSX.Element {
  return <EmptyState icon="mail" title="Select a message to read it" text={`${unread > 0 ? `${unread} unread in this folder.` : 'Nothing unread here.'} Ask Aielia on the right to find, summarise or sort mail.`} />
}
