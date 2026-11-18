import type { EmailCache } from './cache.js'
import type { Account, Message, Triage } from './model.js'
import type { TriageStore } from './triage.js'

/**
 * The eligibility gate for filing rules (plans/aielia_email_capabilities_plan.html, C6). A rule may only touch mail that needs no real
 * action. This is decided in code from records, never from a sentence in a prompt, at three moments: when a rule is proposed (every
 * example behind it must be eligible), when a rule matches new or existing mail, and again after the mail is filed (a reply that arrives
 * later pulls the thread back out). Everything fails closed: a thread with no triage record is NOT eligible, so unreviewed mail stays
 * in the inbox until it has been reviewed.
 *
 * A thread is eligible only when ALL hold: it has a triage record, the record says no reply is needed, no deadline, nobody to wait on,
 * a no-action category (newsletter, receipt, notification, promotion; calendar invites often need an answer, so they are not), the user
 * has never written in the thread, and no sender or recipient in it is someone the user has written to. No `node:*`, no DOM imports.
 */

export const NO_ACTION_CATEGORIES: ReadonlySet<Triage['category']> = new Set<Triage['category']>(['newsletter', 'receipt', 'notification', 'promotion'])

export type GateReason = 'no_triage' | 'needs_reply' | 'deadline' | 'waiting_on' | 'category' | 'you_wrote_in_thread' | 'correspondent'
export type GateVerdict = { eligible: true } | { eligible: false; reason: GateReason }

export const GATE_REASON_TEXT: Record<GateReason, string> = {
  no_triage: 'it has not been reviewed yet',
  needs_reply: 'it needs a reply from you',
  deadline: 'it carries a deadline',
  waiting_on: 'you are waiting on someone in it',
  category: 'it is the kind of mail that may need you (not a newsletter, receipt, notification or promotion)',
  you_wrote_in_thread: 'you have written in this thread',
  correspondent: 'it involves someone you write to',
}

export interface RuleGate { check(m: Message): Promise<GateVerdict> }

export interface GateRecords {
  triage: TriageStore
  /** Lower-case addresses the user has written to. */
  correspondents: ReadonlySet<string>
  /** The user's own addresses. */
  ownAddresses: readonly string[]
}

const addr = (a: string): string => a.trim().toLowerCase()

/** The decision for one thread from its triage record and messages. Pure. */
export function threadEligibility(messages: readonly Message[], triage: Triage | undefined, rec: Pick<GateRecords, 'correspondents' | 'ownAddresses'>): GateVerdict {
  if (!triage) return { eligible: false, reason: 'no_triage' }
  if (triage.needsReply) return { eligible: false, reason: 'needs_reply' }
  if (triage.dueDate) return { eligible: false, reason: 'deadline' }
  if (triage.waitingOn) return { eligible: false, reason: 'waiting_on' }
  if (!NO_ACTION_CATEGORIES.has(triage.category)) return { eligible: false, reason: 'category' }
  const own = new Set(rec.ownAddresses.map(addr))
  if (messages.some((m) => own.has(addr(m.from.address)))) return { eligible: false, reason: 'you_wrote_in_thread' }
  const known = new Set([...rec.correspondents].map(addr))
  if (messages.some((m) => known.has(addr(m.from.address)) || [...m.to, ...m.cc].some((t) => known.has(addr(t.address))))) return { eligible: false, reason: 'correspondent' }
  return { eligible: true }
}

/** Every address the user has written to: the recipients of the user's own messages in the cache. */
export async function correspondentsOf(cache: EmailCache, account: Pick<Account, 'id' | 'address'>): Promise<Set<string>> {
  const own = addr(account.address)
  const out = new Set<string>()
  for (let offset = 0; ; offset += 500) {
    const page = await cache.queryMessages({ sender: account.address }, { offset, limit: 500 })
    for (const m of page.items) if (m.accountId === account.id) for (const t of [...m.to, ...m.cc]) if (addr(t.address) !== own) out.add(addr(t.address))
    if (offset + 500 >= page.total) break
  }
  return out
}

/** The gate over a cache: loads the thread of the message and decides. Records are read fresh for every check. */
export function createRuleGate(cache: EmailCache, rec: GateRecords): RuleGate {
  return {
    async check(m: Message): Promise<GateVerdict> {
      const thread = (await cache.queryMessages({ threadId: m.threadId }, { offset: 0, limit: 200 })).items.filter((x) => x.accountId === m.accountId)
      return threadEligibility(thread.length > 0 ? thread : [m], await rec.triage.get(m.threadId), rec)
    },
  }
}

/** The ids of the messages that pass the gate, for deciding which examples may back a proposed rule. */
export async function eligibleMessageIds(messages: readonly Message[], gate: RuleGate): Promise<Set<string>> {
  const ok = new Set<string>()
  for (const m of messages) if ((await gate.check(m)).eligible) ok.add(m.id)
  return ok
}
