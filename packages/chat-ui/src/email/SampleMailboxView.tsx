import { useState } from 'react'
import type { SampleMailbox } from './sample-mode'
import { EmailLayout } from './EmailLayout'

/**
 * The sample mailbox: the Inbox of the invented mailbox, and a chat box whose every answer says this is a sample. The full layout (U3 onward) replaces
 * the plain lists here; what stays is the notice and that no model is ever called.
 */
export function SampleMailboxView({ sample, onConnect }: { sample: SampleMailbox; onConnect: () => void }): React.JSX.Element {
  const [text, setText] = useState('')
  const [lines, setLines] = useState<Array<{ from: 'you' | 'aielia'; text: string }>>([])
  const [openId, setOpenId] = useState<string | undefined>()
  const open = sample.inbox.find((m) => m.id === openId)
  const send = async (): Promise<void> => {
    const t = text.trim()
    if (!t) return
    setText('')
    const r = await sample.ask(t)
    setLines((l) => [...l, { from: 'you', text: t }, { from: 'aielia', text: r.reply }])
  }
  return (
    <div className="write email-sample">
      <EmailLayout
        readerOpen={!!open}
        banner={
          <div className="write__sample" role="note">
            <span className="write__sample-text"><strong>Sample.</strong> These messages are invented. Connect your mail and your AI to use Aielia on your own.</span>
            <button type="button" className="write__sample-add" onClick={onConnect}>Connect</button>
          </div>
        }
        folders={<nav aria-label="Folder list"><ul>{sample.folders.map((f) => <li key={f.id}>{f.name}{f.unreadCount ? ` (${f.unreadCount})` : ''}</li>)}</ul></nav>}
        list={
          <>
            <h2>Inbox</h2>
            <ul aria-label="Messages">
              {sample.inbox.map((m) => (
                <li key={m.id}><button type="button" onClick={() => setOpenId(m.id)}>{m.from.name ?? m.from.address} — {m.subject}</button></li>
              ))}
            </ul>
          </>
        }
        reader={open ? <article aria-label="Message"><h3>{open.subject}</h3><pre>{open.textBody}</pre></article> : <p>Select a message to read it.</p>}
        aielia={
          <>
            <ul>{lines.map((l, i) => <li key={i} data-from={l.from}>{l.text}</li>)}</ul>
            <input aria-label="Ask Aielia" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void send() }} />
            <button type="button" onClick={() => void send()}>Send</button>
          </>
        }
      />
    </div>
  )
}
