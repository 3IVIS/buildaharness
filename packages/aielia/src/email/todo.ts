import type { Message, Thread, Triage, TodoItem } from './model.js'

/**
 * The to-do list (A3, plan section 7). Built from triage records: threads that need a reply, plus threads the user is waiting
 * on. Two separate scores (priority: how much it matters; urgency: how soon) come from named signals, the four groups come from
 * the scores, and every item carries a reason a person can read. A drag or "this is not urgent" is recorded as a correction and
 * wins over the automatic placement. Items complete themselves when the reply is sent or the thread is archived as resolved,
 * and reappear when the other person writes again. A "never miss" floor keeps a direct question from a known person out of
 * "can wait". Pure functions, no model call, no `node:*` and no DOM imports.
 */

export type TodoGroup = TodoItem['group']
export const TODO_GROUPS: readonly TodoGroup[] = ['do_now', 'schedule', 'quick_answers', 'can_wait']
export const TODO_GROUP_LABEL: Record<TodoGroup, string> = {
  do_now: 'Do now', schedule: 'Schedule', quick_answers: 'Quick answers', can_wait: 'Can wait',
}

export type TodoCorrectionKind = 'move' | 'not_urgent' | 'not_important'
export interface TodoCorrection {
  threadId: string
  kind: TodoCorrectionKind
  /** Required for `move`. */
  group?: TodoGroup
  at: string
}

/** A to-do item with the two scores that placed it (0-100 each). */
export interface ScoredTodo extends TodoItem {
  kind: 'reply' | 'waiting'
  priorityScore: number
  urgencyScore: number
  /** True when the user's own correction, not the automatic placement, decided the group. */
  corrected: boolean
}

export interface TodoThread { thread: Thread; messages: readonly Message[] }

export interface TodoInputs {
  triage: readonly Triage[]
  threads: readonly TodoThread[]
  /** The user's own addresses, lower-cased comparison. */
  userAddresses: readonly string[]
  /** Addresses the user has a history with (replied to, or wrote to). */
  knownContacts?: readonly string[]
  /** Items from an earlier build; their status (done, snoozed, dismissed) is carried forward. */
  existing?: readonly TodoItem[]
  corrections?: readonly TodoCorrection[]
  /** Threads the user archived as resolved. */
  resolvedThreadIds?: readonly string[]
  /** Hand-added items are passed through untouched. */
  now: () => string
}

const PRIORITY_BASE = { high: 80, normal: 50, low: 20 } as const
const URGENCY_BASE = { now: 90, soon: 65, later: 35, none: 10 } as const
const QUICK_BODY_CHARS = 300
const DAY_MS = 86_400_000

const lc = (s: string) => s.trim().toLowerCase()
const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)))
const time = (iso: string) => Date.parse(iso)

export const replyItemId = (threadId: string) => `todo:reply:${threadId}`
export const waitingItemId = (threadId: string) => `todo:wait:${threadId}`

function lastBy(messages: readonly Message[], mine: (m: Message) => boolean, want: boolean): Message | undefined {
  let best: Message | undefined
  for (const m of messages) {
    if (mine(m) !== want || m.flags.draft) continue
    if (!best || time(m.date) >= time(best.date)) best = m
  }
  return best
}

export interface Scores { priority: number; urgency: number; signals: string[]; neverMiss: boolean; quick: boolean }

/** Score one triage record. `lastIncoming` is the newest message from someone else. */
export function scoreTriage(
  t: Triage, lastIncoming: Message | undefined, opts: { userAddresses: readonly string[]; knownContacts?: readonly string[]; now: string },
): Scores {
  const signals: string[] = []
  const users = new Set(opts.userAddresses.map(lc))
  const known = new Set((opts.knownContacts ?? []).map(lc))
  let priority: number = PRIORITY_BASE[t.priority]
  let urgency: number = URGENCY_BASE[t.urgency]
  signals.push(`triage says ${t.priority} priority`)
  if (t.urgency !== 'none') signals.push(`triage says ${t.urgency === 'now' ? 'urgent' : t.urgency === 'soon' ? 'soon' : 'not soon'}`)

  const fromKnown = !!lastIncoming && known.has(lc(lastIncoming.from.address))
  const direct = !!lastIncoming && lastIncoming.to.some((a) => users.has(lc(a.address)))
  if (fromKnown) { priority += 10; signals.push('from someone you correspond with') }
  if (direct && t.needsReply) { priority += 10; signals.push('addressed to you directly') }

  const nowMs = time(opts.now)
  if (t.dueDate) {
    const days = (time(t.dueDate) - nowMs) / DAY_MS
    if (days <= 0) { urgency = Math.max(urgency, 95); signals.push('the stated deadline has passed') }
    else if (days <= 2) { urgency = Math.max(urgency, 85); signals.push('a deadline within two days') }
    else if (days <= 7) { urgency = Math.max(urgency, 55); signals.push('a deadline within a week') }
    else signals.push('a deadline more than a week away')
  }
  if (lastIncoming) {
    const waited = (nowMs - time(lastIncoming.date)) / DAY_MS
    if (waited >= 1) {
      urgency += Math.min(15, Math.floor(waited) * 3)
      signals.push(`waiting ${Math.floor(waited)} day${Math.floor(waited) === 1 ? '' : 's'}`)
    }
  }

  const neverMiss = t.needsReply && t.category === 'person' && fromKnown && direct
  if (neverMiss) { priority = Math.max(priority, 70); signals.push('direct message from a known person, never missed') }
  const quick = t.needsReply && !!lastIncoming && lastIncoming.textBody.trim().length <= QUICK_BODY_CHARS
  return { priority: clamp(priority), urgency: clamp(urgency), signals, neverMiss, quick }
}

/** Place an item in one of the four groups from its scores. */
export function groupFor(s: Pick<Scores, 'priority' | 'urgency' | 'neverMiss' | 'quick'>, dueSoon: boolean): TodoGroup {
  if (s.urgency >= 70 && s.priority >= 50) return 'do_now'
  if (s.quick && s.priority >= 30) return 'quick_answers'
  if (s.urgency >= 40 || dueSoon || s.priority >= 70 || s.neverMiss) return 'schedule'
  return 'can_wait'
}

/** Add a correction; a later one of the same kind for the same thread replaces the earlier one. */
export function recordCorrection(list: readonly TodoCorrection[], c: TodoCorrection): TodoCorrection[] {
  if (c.kind === 'move' && !c.group) throw new Error('A move correction needs a target group.')
  const rest = list.filter((x) => !(x.threadId === c.threadId && x.kind === c.kind))
  // A move supersedes the soft corrections, which only matter to the automatic placement it replaces.
  const kept = c.kind === 'move' ? rest.filter((x) => x.threadId !== c.threadId || x.kind === 'move') : rest
  return [...kept, c]
}

function titleFor(thread: Thread, kind: 'reply' | 'waiting', waitingOn?: string): string {
  const subject = thread.subject.trim() || '(no subject)'
  return kind === 'reply' ? `Reply: ${subject}` : `Waiting on ${waitingOn ?? 'someone'}: ${subject}`
}

/** Build the list. Deterministic for the same inputs. */
export function buildTodoList(inp: TodoInputs): ScoredTodo[] {
  const now = inp.now()
  const users = new Set(inp.userAddresses.map(lc))
  const mine = (m: Message) => users.has(lc(m.from.address))
  const byThread = new Map(inp.threads.map((t) => [t.thread.id, t]))
  const existing = new Map((inp.existing ?? []).map((i) => [i.id, i]))
  const resolved = new Set(inp.resolvedThreadIds ?? [])
  const out: ScoredTodo[] = []

  for (const t of inp.triage) {
    const th = byThread.get(t.threadId)
    if (!th) continue
    const kind: 'reply' | 'waiting' | undefined = t.needsReply ? 'reply' : t.waitingOn ? 'waiting' : undefined
    if (!kind) continue
    const id = kind === 'reply' ? replyItemId(t.threadId) : waitingItemId(t.threadId)
    const lastIn = lastBy(th.messages, mine, false)
    const lastOut = lastBy(th.messages, mine, true)
    const prior = existing.get(id)

    const sc = scoreTriage(t, lastIn, { userAddresses: inp.userAddresses, knownContacts: inp.knownContacts, now })
    let priority = sc.priority
    let urgency = sc.urgency
    const signals = [...sc.signals]
    if (kind === 'waiting' && lastOut) {
      const waited = Math.floor((time(now) - time(lastOut.date)) / DAY_MS)
      urgency = clamp(Math.max(urgency, 10) + Math.min(40, waited * 5))
      priority = Math.min(priority, 60)
      signals.length = 0
      signals.push(`you wrote ${waited >= 1 ? `${waited} day${waited === 1 ? '' : 's'} ago` : 'today'} and have no answer`)
      if (t.dueDate) signals.push('a deadline is stated')
    }

    const corr = (inp.corrections ?? []).filter((c) => c.threadId === t.threadId)
    const move = corr.find((c) => c.kind === 'move')
    let reason = ''
    if (corr.some((c) => c.kind === 'not_urgent')) { urgency = Math.min(urgency, 10); signals.push('you said this is not urgent') }
    if (corr.some((c) => c.kind === 'not_important')) { priority = Math.min(priority, 20); signals.push('you said this is not important') }
    const dueSoon = !!t.dueDate && (time(t.dueDate) - time(now)) / DAY_MS <= 7 && !corr.some((c) => c.kind === 'not_urgent')
    let group = groupFor({ priority, urgency, neverMiss: sc.neverMiss && kind === 'reply', quick: kind === 'reply' && sc.quick }, dueSoon)
    if (move?.group) {
      group = move.group
      reason = `You moved this to ${TODO_GROUP_LABEL[group]}.`
    } else {
      reason = `${TODO_GROUP_LABEL[group]}: ${signals.join('; ')}. ${t.reason}`.trim()
    }

    // Status: carry forward, then apply the completion and reappearance rules.
    let status: TodoItem['status'] = prior?.status ?? 'open'
    let completedAt = prior?.completedAt
    let snoozeUntil = prior?.snoozeUntil
    const incomingAfter = (iso?: string) => !!lastIn && (!iso || time(lastIn.date) > time(iso))
    if (status === 'snoozed' && snoozeUntil && time(snoozeUntil) <= time(now)) { status = 'open'; snoozeUntil = undefined }
    if (status === 'open' || status === 'snoozed') {
      const done = kind === 'reply'
        ? !!lastOut && (!lastIn || time(lastOut.date) > time(lastIn.date))
        : !!lastIn && (!lastOut || time(lastIn.date) > time(lastOut.date))
      // Stamp the completion with the message that caused it, so a later message from the other side is "after" it.
      if (done) { status = 'done'; completedAt = (kind === 'reply' ? lastOut : lastIn)?.date ?? now; snoozeUntil = undefined }
      else if (resolved.has(t.threadId)) { status = 'done'; completedAt = now; snoozeUntil = undefined }
    } else if (status === 'done' && !resolved.has(t.threadId)) {
      // Reappears when the other person writes after it was completed (a reply item), or the user must act on their answer.
      if (kind === 'reply' && incomingAfter(completedAt)) { status = 'open'; completedAt = undefined }
    }

    out.push({
      id, threadId: t.threadId, title: titleFor(th.thread, kind, t.waitingOn?.name ?? t.waitingOn?.address),
      origin: 'triage', status, group, reason, createdAt: prior?.createdAt ?? now,
      ...(t.dueDate ? { dueDate: t.dueDate } : {}),
      ...(snoozeUntil ? { snoozeUntil } : {}),
      ...(completedAt ? { completedAt } : {}),
      kind, priorityScore: priority, urgencyScore: urgency, corrected: !!move,
    })
  }

  // Hand-added items pass through; they have no triage record to score.
  for (const e of inp.existing ?? []) {
    if (e.origin === 'manual') out.push({ ...e, kind: 'reply', priorityScore: 50, urgencyScore: 10, corrected: false })
  }
  return sortTodo(out)
}

/** Group order first, then priority, then urgency, then id for a stable order. */
export function sortTodo<T extends ScoredTodo>(items: readonly T[]): T[] {
  return [...items].sort((a, b) =>
    TODO_GROUPS.indexOf(a.group) - TODO_GROUPS.indexOf(b.group)
    || b.priorityScore - a.priorityScore || b.urgencyScore - a.urgencyScore || a.id.localeCompare(b.id))
}

/** The open items, grouped in display order (empty groups kept so a surface can show all four). */
export function groupTodo(items: readonly ScoredTodo[]): Array<{ group: TodoGroup; label: string; items: ScoredTodo[] }> {
  const open = items.filter((i) => i.status === 'open')
  return TODO_GROUPS.map((group) => ({ group, label: TODO_GROUP_LABEL[group], items: open.filter((i) => i.group === group) }))
}
