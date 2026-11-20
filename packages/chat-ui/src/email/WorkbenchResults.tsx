import type { CatchUpView, EmailReplyDraft, RuleProposal, SendersView, SpamView, WorkbenchEvent } from '@buildaharness/aielia'

/**
 * How the review tasks answer, drawn inside a chat message of the Aielia column. Everything here reads: nothing is moved, saved to Mail or sent,
 * and spam and rules are proposals. Text from mail (subjects, reasons, names) is only ever rendered as text.
 */

export interface RulesView { proposals: RuleProposal[]; filed: number; sampled: number; eligible: number }

const matchText = (m: RuleProposal['rule']['match']): string => (m.kind === 'sender' ? m.address : m.kind === 'domain' ? m.domain : m.kind === 'list_header' ? m.value : m.kind === 'subject_pattern' ? m.pattern : m.text)
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

export function CatchUpResult({ view, onOpen }: { view: CatchUpView; onOpen?: (threadId: string) => void }): React.JSX.Element {
  if (view.note) return <p role="status" className="wb__note">{view.note}</p>
  return (
    <div>
      <p className="wb__lead">{view.summary.join(' ')}</p>
      <ul className="wb__list">
        {view.needsResponse.map((n) => (
          <li key={n.threadId}>
            {onOpen ? <button type="button" className="wb__link" onClick={() => onOpen(n.threadId)}>{n.subject}</button> : n.subject}
            <span className="wb__muted">{n.folder ? ` (in ${n.folder})` : ''} {n.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function SpamResult({ view }: { view: SpamView }): React.JSX.Element {
  if (view.note) return <p role="status" className="wb__note">{view.note}</p>
  return (
    <p>
      {view.rows.length} probably spam, {view.unsure} unsure, {view.notSpam} not spam of {view.threads} threads (last {view.windowDays} days).
      {view.rows.length > 0 ? ' They are listed above your messages. ' : ' '}Nothing was moved. A company&apos;s newsletter is never called spam: only suspicious senders and unsolicited sales are candidates.
    </p>
  )
}

export function SendersResult({ view }: { view: SendersView }): React.JSX.Element {
  if (view.note) return <p role="status" className="wb__note">{view.note}</p>
  return (
    <div>
      <p className="wb__lead">{view.total} senders in the last {view.windowDays} days, by kind.{view.unsorted > 0 ? ` ${view.unsorted} could not be placed yet.` : ''}</p>
      {view.groups.map((g) => (
        <details key={g.kind} className="wb__group" open={g.kind === 'suspicious' || g.kind === 'cold_outreach'}>
          <summary>{g.label} ({g.senders.length})</summary>
          <ul className="wb__list">{g.senders.map((r) => <li key={r.sender} title={r.reason}>{r.name ? `${r.name} ` : ''}<span className="wb__muted">{r.sender} · {r.threads} {r.threads === 1 ? 'thread' : 'threads'} · {r.reason}</span></li>)}</ul>
        </details>
      ))}
    </div>
  )
}

export function RulesResult({ view }: { view: RulesView }): React.JSX.Element {
  return (
    <div>
      <p className="wb__lead">{view.eligible} of {view.sampled} sampled filed messages may teach a rule (the rest may need action). {view.proposals.length} proposals, none applied.</p>
      <ul className="wb__list">
        {view.proposals.map((p) => (
          <li key={p.rule.id}>{p.rule.match.kind}: {matchText(p.rule.match)} → {p.folder}
            <span className="wb__muted"> · {p.examples} examples · {p.inboxHits} in the inbox now, {p.heldByGate} held back</span></li>
        ))}
      </ul>
    </div>
  )
}

export function DraftResult({ subject, draft, refused }: { subject: string; draft?: EmailReplyDraft; refused?: string }): React.JSX.Element {
  if (!draft) return <p role="status" className="wb__note">No draft: {refused}</p>
  return (
    <div>
      <p className="wb__lead">Draft reply to “{subject}”:</p>
      <pre className="wb__draft">{draft.body}</pre>
      <p className="wb__muted">Shown here only. It is not saved to Mail and not sent.</p>
    </div>
  )
}

/** One line of the activity log. A model call is a fold-out with what was sent and what came back. */
export function EventLine({ e }: { e: WorkbenchEvent }): React.JSX.Element {
  switch (e.kind) {
    case 'model_end':
      return (
        <details className="wb__event">
          <summary>model #{e.n} · {e.label} · {seconds(e.ms)}</summary>
          <p className="wb__muted">Instructions</p><pre>{e.system}</pre>
          <p className="wb__muted">Sent (mail text, shortened)</p><pre>{e.prompt}</pre>
          <p className="wb__muted">Came back</p><pre>{e.response}</pre>
        </details>
      )
    case 'model_start': return <div className="wb__event wb__muted">model #{e.n} · {e.label} · sending {e.userChars} characters…</div>
    case 'model_error': return <div className="wb__event wb__bad" role="alert">model #{e.n} failed: {e.error}</div>
    case 'tool': return <div className="wb__event">tool {e.name} {e.args}</div>
    case 'tool_result': return <div className="wb__event wb__muted">↳ {e.name}: {e.ok ? 'ok' : 'failed'}, {e.chars} characters, {e.citations} cited</div>
    case 'error': return <div className="wb__event wb__bad" role="alert">{e.text}</div>
    default: return <div className="wb__event">{e.text}</div>
  }
}

/** What Aielia is doing, under the chat: folded away until work starts, with every model call inside it. */
export function ActivityLog({ events, working }: { events: readonly WorkbenchEvent[]; working: boolean }): React.JSX.Element | null {
  if (events.length === 0) return null
  return (
    <details className="wb__activity" open={working}>
      <summary>What Aielia is doing ({events.length})</summary>
      <div className="wb__log">{events.slice(-80).map((e, i) => <EventLine key={i} e={e} />)}</div>
    </details>
  )
}
