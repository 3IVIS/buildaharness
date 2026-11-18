import type { Message } from './model.js'

/**
 * Conversation grouping (plans/aielia_email_capabilities_plan.html, C1). Providers give each message a `threadId` (Gmail and Graph from the
 * server, IMAP from References). This module reconciles those ids over the messages the user is looking at, structurally and without a model:
 *
 *  1. Messages that share a provider thread id are one conversation.
 *  2. A message whose `in-reply-to` or `references` names another message's `message-id` joins that message's conversation (this joins a Sent
 *     copy that came back under a different thread id).
 *  3. A message with NO reference headers at all joins the nearest earlier conversation with the same normalised subject, only when the two share
 *     a participant, the gap is at most `maxGapDays`, and the subject is more than a bare word ("Re: invoice" from two strangers stay apart).
 *
 * Anything uncertain stays separate: a wrongly merged conversation hides mail, a split one only costs a row. No `node:*` and no DOM imports.
 */

export interface ConversationOptions { maxGapDays?: number }

/** How many earlier same-subject messages are looked at for a join. */
const MAX_CANDIDATES = 50
const PREFIX = /^\s*((re|fw|fwd|aw|wg|sv|vs|antw)\s*(\[\d+\])?\s*:\s*)+/i

/** A subject with reply and forward prefixes and surrounding space removed, lower-cased. */
export function normaliseSubject(subject: string): string {
  return subject.replace(PREFIX, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

const ids = (v: string | undefined): string[] => (v ? [...v.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1]!.toLowerCase()) : [])
const ownId = (m: Message): string | undefined => ids(m.headers['message-id'])[0]
const people = (m: Message): string[] => [m.from, ...m.to, ...m.cc].map((a) => a.address.toLowerCase())

/** A subject with fewer than two words and no digits is too generic to join mail on alone. */
const joinable = (norm: string): boolean => norm.split(' ').filter(Boolean).length >= 2 || /\d/.test(norm)

class Sets {
  private parent = new Map<string, string>()
  find(x: string): string {
    let r = this.parent.get(x) ?? x
    while ((this.parent.get(r) ?? r) !== r) r = this.parent.get(r)!
    this.parent.set(x, r)
    return r
  }
  union(a: string, b: string): void {
    const ra = this.find(a), rb = this.find(b)
    if (ra !== rb) this.parent.set(rb < ra ? ra : rb, rb < ra ? rb : ra)
  }
}

/** The conversation id of every message (by message id). The id is the smallest member thread id, so it is stable as messages arrive. */
export function groupConversations(messages: readonly Message[], opts: ConversationOptions = {}): Map<string, string> {
  const maxGap = (opts.maxGapDays ?? 21) * 86_400_000
  const sets = new Sets()
  for (const m of messages) sets.find(`t:${m.threadId}`)

  // 2. Reference headers.
  const byRfc = new Map<string, Message>()
  for (const m of messages) { const id = ownId(m); if (id) byRfc.set(id, m) }
  for (const m of messages) {
    for (const ref of [...ids(m.headers['in-reply-to']), ...ids(m.headers['references'])]) {
      const target = byRfc.get(ref)
      if (target && target.accountId === m.accountId) sets.union(`t:${m.threadId}`, `t:${target.threadId}`)
    }
  }

  // 3. Subject fallback for header-less messages only.
  const sorted = [...messages].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1))
  const seen = new Map<string, Message[]>()
  for (const m of sorted) {
    const norm = normaliseSubject(m.subject)
    const headerless = ids(m.headers['in-reply-to']).length === 0 && ids(m.headers['references']).length === 0
    if (headerless && PREFIX.test(m.subject) && joinable(norm)) {
      const mine = new Set(people(m))
      // Newest candidates first, and only a bounded number: a thousand identical subjects must not make this quadratic.
      const cands = seen.get(`${m.accountId}|${norm}`) ?? []
      let hit: Message | undefined
      for (let i = cands.length - 1, looked = 0; i >= 0 && looked < MAX_CANDIDATES; i--, looked++) {
        const o = cands[i]!
        if (Date.parse(m.date) - Date.parse(o.date) > maxGap) break
        if (people(o).some((p) => mine.has(p))) { hit = o; break }
      }
      if (hit) sets.union(`t:${m.threadId}`, `t:${hit.threadId}`)
    }
    const key = `${m.accountId}|${norm}`
    const list = seen.get(key)
    if (list) list.push(m)
    else seen.set(key, [m])
  }

  const out = new Map<string, string>()
  for (const m of messages) out.set(m.id, sets.find(`t:${m.threadId}`).slice(2))
  return out
}
