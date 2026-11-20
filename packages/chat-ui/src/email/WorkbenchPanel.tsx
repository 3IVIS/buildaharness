import { useState } from 'react'
import type { CatchUpView, RuleProposal, SendersView, SpamView, WorkbenchEvent } from '@buildaharness/aielia'
import './workbench.css'

export interface RulesView { proposals: RuleProposal[]; filed: number; sampled: number; eligible: number }

interface Props {
  running: string | undefined
  events: readonly WorkbenchEvent[]
  catchUp?: CatchUpView
  spam?: SpamView
  senders?: SendersView
  rules?: RulesView
  error?: string
  onCatchUp: (days: 7 | 30 | 90) => void
  onSpam: (days: 7 | 30 | 90) => void
  onSenders: (days: 7 | 30 | 90) => void
  onRules: () => void
  onTodo: () => void
  onOpenThread?: (threadId: string) => void
}

const matchText = (m: RuleProposal['rule']['match']): string => (m.kind === 'sender' ? m.address : m.kind === 'domain' ? m.domain : m.kind === 'list_header' ? m.value : m.kind === 'subject_pattern' ? m.pattern : m.text)
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

function EventLine({ e }: { e: WorkbenchEvent }): React.JSX.Element {
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

/**
 * The review controls of a live mailbox and what they are doing. Everything here reads: nothing is moved, drafted or sent, and spam and rules are
 * proposals. The activity list shows each model call with what was sent and what came back, so the person can see exactly what Aielia is doing.
 */
export function WorkbenchPanel({ running, events, catchUp, spam, senders, rules, error, onCatchUp, onSpam, onSenders, onRules, onTodo, onOpenThread }: Props): React.JSX.Element {
  const [days, setDays] = useState<7 | 30 | 90>(7)
  const busy = running !== undefined
  return (
    <details className="wb" open>
      <summary>Aielia review <span className="wb__muted">{busy ? `· ${running}…` : '· read-only: nothing is changed or sent'}</span></summary>
      <div className="wb__bar">
        <select aria-label="Window" value={days} onChange={(e) => setDays(Number(e.target.value) as 7 | 30 | 90)} disabled={busy}>
          <option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option>
        </select>
        <button type="button" disabled={busy} onClick={() => onCatchUp(days)}>What needs a response?</button>
        <button type="button" disabled={busy} onClick={() => onSenders(days)}>Sort senders</button>
        <button type="button" disabled={busy} onClick={() => onSpam(days)}>Spam check</button>
        <button type="button" disabled={busy} onClick={onRules}>Rule proposals</button>
        <button type="button" disabled={busy} onClick={onTodo}>Update To do</button>
      </div>
      {error && <p role="alert" className="wb__bad">{error}</p>}
      {catchUp && (
        <div className="wb__card">
          <strong>{catchUp.windowLabel}</strong>
          {catchUp.note ? <p role="status" className="wb__note">{catchUp.note}</p> : <p>{catchUp.summary.join(' ')}</p>}
          <ul>{catchUp.needsResponse.map((n) => (
            <li key={n.threadId}>
              {onOpenThread ? <button type="button" className="wb__link" onClick={() => onOpenThread(n.threadId)}>{n.subject}</button> : n.subject}
              <span className="wb__muted">{n.folder ? ` (in ${n.folder})` : ''} {n.reason}</span>
            </li>
          ))}</ul>
        </div>
      )}
      {senders && (
        <div className="wb__card">
          <strong>Senders, last {senders.windowDays} days</strong>
          {senders.note
            ? <p role="status" className="wb__note">{senders.note}</p>
            : (
              <>
                <p className="wb__muted">{senders.total} senders sorted by what kind of sender they are. Only suspicious senders and unsolicited sales can ever be called spam; a company&apos;s newsletter is a newsletter.{senders.unsorted > 0 ? ` ${senders.unsorted} could not be placed yet.` : ''}</p>
                {senders.groups.map((g) => (
                  <details key={g.kind} className="wb__group" open={g.kind === 'suspicious' || g.kind === 'cold_outreach'}>
                    <summary>{g.label} ({g.senders.length})</summary>
                    <ul>{g.senders.map((r) => <li key={r.sender} title={r.reason}>{r.name ? `${r.name} ` : ''}<span className="wb__muted">{r.sender} · {r.threads} {r.threads === 1 ? 'thread' : 'threads'} · {r.reason}</span></li>)}</ul>
                  </details>
                ))}
              </>
            )}
        </div>
      )}
      {spam && (
        <div className="wb__card">
          <strong>Spam check, last {spam.windowDays} days</strong>
          {spam.note
            ? <p role="status" className="wb__note">{spam.note}</p>
            : <p>{spam.rows.length} probably spam, {spam.unsure} unsure, {spam.notSpam} not spam of {spam.threads} threads. Learned from your Junk folder: {spam.learned.senders} senders, {spam.learned.domains} domains. Nothing was moved.</p>}
        </div>
      )}
      {rules && (
        <div className="wb__card">
          <strong>Rule proposals (none applied)</strong>
          <p className="wb__muted">{rules.eligible} of {rules.sampled} sampled filed messages may teach a rule; the rest may need action.</p>
          <ul>{rules.proposals.map((p) => (
            <li key={p.rule.id}>{p.rule.match.kind}: {matchText(p.rule.match)} → {p.folder}
              <span className="wb__muted"> · {p.examples} examples · {p.inboxHits} in the inbox now, {p.heldByGate} held back</span></li>
          ))}</ul>
        </div>
      )}
      <details className="wb__activity" open={busy}>
        <summary>What Aielia is doing ({events.length})</summary>
        <div className="wb__log">{events.slice(-80).map((e, i) => <EventLine key={i} e={e} />)}</div>
      </details>
    </details>
  )
}
