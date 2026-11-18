import { useState } from 'react'
import { acceptDraftEdit, rejectDraftEdit, type EmailReplyDraft, type SendCoordinator, type StagedSend } from '@buildaharness/aielia'
import { pendingSuggestions, stagedFromDraft } from './reply-compose'

interface ComposerProps {
  initial: EmailReplyDraft
  coordinator: SendCoordinator
  /** Phones open the reply full screen. */
  fullScreen?: boolean
  onSent?: (result: { status: 'sent' | 'held'; messageId: string }) => void
  onClose?: () => void
}

/** The send confirmation: every recipient, the subject and the text, plus an extra warning per recipient who is not on the thread. Send is the only way out that sends. */
export function SendApproval({ staged, onApprove, onCancel }: { staged: StagedSend; onApprove: () => void; onCancel: () => void }): React.JSX.Element {
  const m = staged.message
  const list = (xs: { address: string }[]): string => xs.map((a) => a.address).join(', ')
  return (
    <div role="alertdialog" aria-label="Approve send" className="reply__approval">
      <h3>Send this message?</h3>
      <dl>
        <dt>To</dt><dd>{list(m.to)}</dd>
        {m.cc.length > 0 && <><dt>Cc</dt><dd>{list(m.cc)}</dd></>}
        {m.bcc.length > 0 && <><dt>Bcc</dt><dd>{list(m.bcc)}</dd></>}
        <dt>Subject</dt><dd>{m.subject}</dd>
      </dl>
      <pre className="reply__text">{m.textBody}</pre>
      {staged.warnings.map((w) => <p key={w} role="alert" className="reply__warn">Warning: {w}</p>)}
      <div className="reply__actions">
        <button type="button" className="reply__primary" onClick={onApprove}>Send</button>
        <button type="button" onClick={onCancel}>Back to editing</button>
      </div>
    </div>
  )
}

/** The reply draft opened inline under the message: editable text, Cc/Bcc, suggestions to accept or reject, and a send that always goes through the approval. */
export function ReplyComposer({ initial, coordinator, fullScreen, onSent, onClose }: ComposerProps): React.JSX.Element {
  const [draft, setDraft] = useState(initial)
  const [cc, setCc] = useState('')
  const [bcc, setBcc] = useState('')
  const [staged, setStaged] = useState<StagedSend | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pending = pendingSuggestions(draft)

  const act = (r: ReturnType<typeof acceptDraftEdit>): void => {
    if (r.ok) { setDraft(r.draft); setError(null) } else setError(r.reason)
  }
  const review = async (): Promise<void> => {
    try { setStaged(await coordinator.stage(stagedFromDraft(draft, { cc, bcc }))); setError(null) } catch (e) { setError((e as Error).message) }
  }
  const approve = async (): Promise<void> => {
    if (!staged) return
    try { const r = await coordinator.approve(staged.id, staged.fingerprint); setStaged(null); onSent?.(r) } catch (e) { setError((e as Error).message) }
  }

  return (
    <section aria-label="Reply" className={`reply${fullScreen ? ' reply--full' : ''}`}>
      <header className="reply__head"><strong>Re: {draft.subject}</strong>{onClose && <button type="button" className="email__iconbtn" aria-label="Close reply" title="Close" onClick={onClose}>×</button>}</header>
      <p className="reply__to"><span>To</span> {draft.to.map((a) => a.address).join(', ')}</p>
      <label className="reply__field"><span>Cc</span> <input value={cc} onChange={(e) => setCc(e.target.value)} /></label>
      <label className="reply__field"><span>Bcc</span> <input value={bcc} onChange={(e) => setBcc(e.target.value)} /></label>
      <textarea aria-label="Reply text" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value, savedAs: undefined })} rows={fullScreen ? 16 : 8} />
      {pending.length > 0 && (
        <ul aria-label="Suggestions" className="reply__suggestions">
          {pending.map((s) => (
            <li key={s.id} data-suggestion={s.id}>
              <del>{s.span.quote}</del> <ins>{s.replacement || '(removed)'}</ins>
              <span className="reply__reason">{s.reason}</span>
              <span className="reply__choose">
                <button type="button" className="reply__accept" onClick={() => act(acceptDraftEdit(draft, s.id))}>Accept</button>
                <button type="button" onClick={() => act(rejectDraftEdit(draft, s.id))}>Reject</button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert" className="reply__error">{error}</p>}
      <div className="reply__actions"><button type="button" className="reply__primary" onClick={() => void review()} disabled={staged !== null}>Review and send</button></div>
      {staged && <SendApproval staged={staged} onApprove={() => void approve()} onCancel={() => setStaged(null)} />}
    </section>
  )
}
