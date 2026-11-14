import { useMemo, useState } from 'react'
import type { Message } from '@buildaharness/aielia'
import { sanitizeMailHtml, sanitizeMailText, senderMismatch } from './reader-html'

const formatSize = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

/**
 * The reader (U5). HTML mail renders only in a frame with `sandbox=""` (no scripts, no forms, no same-origin, no
 * navigation) from sanitised srcdoc. Remote images stay blocked until the user allows them for this message. Every link's
 * real destination is printed, a sender whose name claims another address is flagged, hidden text is reported not shown.
 * Attachments are listed and can be opened by the user; Aielia does not read them (plan Q6).
 */
export function MailReader({ message, onOpenAttachment }: { message: Message; onOpenAttachment?: (attachmentId: string) => void }): React.JSX.Element {
  const [allowImages, setAllowImages] = useState(false)
  const view = useMemo(
    () => (message.htmlBody ? sanitizeMailHtml(message.htmlBody, { allowRemoteImages: allowImages }) : sanitizeMailText(message.textBody)),
    [message.htmlBody, message.textBody, allowImages],
  )
  const sender = senderMismatch(message.from)
  const mismatched = view.links.filter((l) => l.mismatch)
  return (
    <article aria-label="Message" className="mail-reader">
      <h3>{message.subject}</h3>
      <p className="mail-reader__from">
        <span>{message.from.name ? `${message.from.name} ` : ''}&lt;{message.from.address}&gt;</span>
      </p>
      {sender.mismatch && <p role="alert" className="mail-reader__warn" data-flag="sender_mismatch">Sender does not match. {sender.detail}</p>}
      {mismatched.length > 0 && (
        <p role="alert" className="mail-reader__warn" data-flag="link_mismatch">
          A link shows one address and goes to another: {mismatched.map((l) => `${l.text} → ${l.href}`).join('; ')}
        </p>
      )}
      {view.hiddenText.length > 0 && <p role="note" className="mail-reader__warn" data-flag="hidden_text">This message contains text you cannot see. It is not shown.</p>}
      {view.blockedImages.length > 0 && !allowImages && (
        <p role="note" className="mail-reader__note">
          {view.blockedImages.length} remote {view.blockedImages.length === 1 ? 'image' : 'images'} blocked.{' '}
          <button type="button" onClick={() => setAllowImages(true)}>Show images</button>
        </p>
      )}
      <iframe title="Message body" sandbox="" referrerPolicy="no-referrer" srcDoc={view.srcdoc} className="mail-reader__frame" />
      {view.links.length > 0 && (
        <details className="mail-reader__links">
          <summary>Links ({view.links.length})</summary>
          <ul>{view.links.map((l, i) => <li key={i} data-mismatch={l.mismatch || undefined}>{l.text ? `${l.text} → ` : ''}{l.href}</li>)}</ul>
        </details>
      )}
      {message.attachments.length > 0 && (
        <ul aria-label="Attachments" className="mail-reader__attachments">
          {message.attachments.map((a) => (
            <li key={a.id}>
              {a.filename} <small>({formatSize(a.sizeBytes)})</small>{' '}
              <button type="button" aria-label={`Open ${a.filename}`} onClick={() => onOpenAttachment?.(a.id)}>Open</button>
            </li>
          ))}
        </ul>
      )}
    </article>
  )
}
