import { describe, it, expect } from 'vitest'
import type { Message, Thread, Triage } from './model.js'
import {
  buildTodoList, groupTodo, groupFor, recordCorrection, replyItemId, waitingItemId, scoreTriage, type TodoThread, type ScoredTodo,
} from './todo.js'

const ME = 'me@example.com'
const NOW = '2026-11-13T10:00:00.000Z'
const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString()

function msg(id: string, threadId: string, from: string, date: string, body = 'Short question?', to = [ME]): Message {
  return {
    id, accountId: 'a', threadId, providerId: id, folderIds: ['inbox'], from: { address: from }, to: to.map((address) => ({ address })), cc: [],
    subject: 's', date, headers: {}, textBody: body, attachments: [],
    flags: { read: false, starred: false, draft: false },
  }
}
function thread(id: string, messages: Message[], subject = `Subject ${id}`): TodoThread {
  const t: Thread = {
    id, accountId: 'a', providerId: id, subject, messageIds: messages.map((m) => m.id), folderIds: ['inbox'],
    participants: [], lastMessageAt: messages[messages.length - 1]!.date, unread: true,
  }
  return { thread: t, messages }
}
const tri = (threadId: string, extra: Partial<Triage> = {}): Triage => ({
  threadId, category: 'person', needsReply: true, priority: 'normal', urgency: 'later', reason: 'A question.', userOverridden: false,
  triagedAt: NOW, ...extra,
})
const base = { userAddresses: [ME], now: () => NOW }
const long = 'x'.repeat(400)

describe('scores and groups', () => {
  it('priority and urgency are separate', () => {
    const a = scoreTriage(tri('t', { priority: 'high', urgency: 'none' }), undefined, { userAddresses: [ME], now: NOW })
    const b = scoreTriage(tri('t', { priority: 'low', urgency: 'now' }), undefined, { userAddresses: [ME], now: NOW })
    expect(a.priority).toBeGreaterThan(b.priority)
    expect(a.urgency).toBeLessThan(b.urgency)
  })

  it('urgent and important is do now; urgent but unimportant long mail is not', () => {
    const th = thread('t1', [msg('m1', 't1', 'x@example.org', daysAgo(0), long)])
    const th2 = thread('t2', [msg('m2', 't2', 'x@example.org', daysAgo(0), long)])
    const items = buildTodoList({
      ...base, threads: [th, th2],
      triage: [tri('t1', { priority: 'high', urgency: 'now' }), tri('t2', { priority: 'low', urgency: 'now' })],
    })
    expect(items.find((i) => i.threadId === 't1')!.group).toBe('do_now')
    expect(items.find((i) => i.threadId === 't2')!.group).toBe('schedule')
  })

  it('a short question is a quick answer; a long, calm one can wait', () => {
    const q = thread('q', [msg('m1', 'q', 'x@example.org', daysAgo(0))])
    const w = thread('w', [msg('m2', 'w', 'x@example.org', daysAgo(0), long)])
    const items = buildTodoList({ ...base, threads: [q, w], triage: [tri('q'), tri('w', { priority: 'low', urgency: 'none' })] })
    expect(items.find((i) => i.threadId === 'q')!.group).toBe('quick_answers')
    expect(items.find((i) => i.threadId === 'w')!.group).toBe('can_wait')
  })

  it('a deadline within two days raises urgency and every item has a visible reason', () => {
    const th = thread('d', [msg('m', 'd', 'x@example.org', daysAgo(0), long)])
    const [item] = buildTodoList({ ...base, threads: [th], triage: [tri('d', { priority: 'high', urgency: 'later', dueDate: new Date(Date.parse(NOW) + 86_400_000).toISOString() })] })
    expect(item!.group).toBe('do_now')
    expect(item!.reason).toMatch(/deadline within two days/)
    expect(item!.reason).toMatch(/A question\./)
  })

  it('waiting time adds urgency', () => {
    const old = scoreTriage(tri('t', { urgency: 'later' }), msg('m', 't', 'x@example.org', daysAgo(4)), { userAddresses: [ME], now: NOW })
    const fresh = scoreTriage(tri('t', { urgency: 'later' }), msg('m', 't', 'x@example.org', daysAgo(0)), { userAddresses: [ME], now: NOW })
    expect(old.urgency).toBeGreaterThan(fresh.urgency)
  })

  it('groupFor never puts a never-miss item in can wait', () => {
    expect(groupFor({ priority: 70, urgency: 0, neverMiss: true, quick: false }, false)).toBe('schedule')
    expect(groupFor({ priority: 20, urgency: 0, neverMiss: false, quick: false }, false)).toBe('can_wait')
  })
})

describe('never-miss floor', () => {
  it('a direct message from a known person with low triage stays out of can wait', () => {
    const th = thread('n', [msg('m', 'n', 'friend@example.org', daysAgo(0), long)])
    const [item] = buildTodoList({ ...base, threads: [th], triage: [tri('n', { priority: 'low', urgency: 'none' })], knownContacts: ['Friend@example.org'] })
    expect(item!.group).not.toBe('can_wait')
    expect(item!.priorityScore).toBeGreaterThanOrEqual(70)
  })

  it('the same mail from a stranger is not floored', () => {
    const th = thread('n', [msg('m', 'n', 'stranger@example.org', daysAgo(0), long)])
    const [item] = buildTodoList({ ...base, threads: [th], triage: [tri('n', { priority: 'low', urgency: 'none' })] })
    expect(item!.group).toBe('can_wait')
  })
})

describe('corrections', () => {
  const th = thread('c', [msg('m', 'c', 'x@example.org', daysAgo(0), long)])
  const t = tri('c', { priority: 'high', urgency: 'now' })

  it('a drag moves the item and says so', () => {
    const corrections = recordCorrection([], { threadId: 'c', kind: 'move', group: 'can_wait', at: NOW })
    const [item] = buildTodoList({ ...base, threads: [th], triage: [t], corrections })
    expect(item!.group).toBe('can_wait')
    expect(item!.corrected).toBe(true)
    expect(item!.reason).toBe('You moved this to Can wait.')
  })

  it('"this is not urgent" lowers urgency and changes the group', () => {
    const before = buildTodoList({ ...base, threads: [th], triage: [t] })[0]!
    const corrections = recordCorrection([], { threadId: 'c', kind: 'not_urgent', at: NOW })
    const after = buildTodoList({ ...base, threads: [th], triage: [t], corrections })[0]!
    expect(before.group).toBe('do_now')
    expect(after.urgencyScore).toBeLessThanOrEqual(10)
    expect(after.group).not.toBe('do_now')
    expect(after.reason).toMatch(/not urgent/)
  })

  it('a later correction replaces an earlier one; a move needs a group', () => {
    let c = recordCorrection([], { threadId: 'c', kind: 'move', group: 'schedule', at: NOW })
    c = recordCorrection(c, { threadId: 'c', kind: 'move', group: 'do_now', at: NOW })
    expect(c).toHaveLength(1)
    expect(c[0]!.group).toBe('do_now')
    expect(() => recordCorrection([], { threadId: 'c', kind: 'move', at: NOW })).toThrow()
  })

  it('a correction on one thread leaves others alone', () => {
    const th2 = thread('d', [msg('m2', 'd', 'x@example.org', daysAgo(0), long)])
    const corrections = recordCorrection([], { threadId: 'c', kind: 'move', group: 'can_wait', at: NOW })
    const items = buildTodoList({ ...base, threads: [th, th2], triage: [t, tri('d', { priority: 'high', urgency: 'now' })], corrections })
    expect(items.find((i) => i.threadId === 'd')!.group).toBe('do_now')
  })
})

describe('completion and reappearance', () => {
  const t = tri('r', { priority: 'high', urgency: 'now' })

  it('completes when the user has replied', () => {
    const th = thread('r', [msg('m1', 'r', 'x@example.org', daysAgo(1)), msg('m2', 'r', ME, daysAgo(0), 'On it.', ['x@example.org'])])
    const [item] = buildTodoList({ ...base, threads: [th], triage: [t] })
    expect(item!.status).toBe('done')
    expect(item!.completedAt).toBe(daysAgo(0))
  })

  it('completes when the thread is archived as resolved', () => {
    const th = thread('r', [msg('m1', 'r', 'x@example.org', daysAgo(1))])
    const [item] = buildTodoList({ ...base, threads: [th], triage: [t], resolvedThreadIds: ['r'] })
    expect(item!.status).toBe('done')
  })

  it('reappears when the other person writes again', () => {
    const first = thread('r', [msg('m1', 'r', 'x@example.org', daysAgo(2)), msg('m2', 'r', ME, daysAgo(1), 'ok', ['x@example.org'])])
    const done = buildTodoList({ ...base, threads: [first], triage: [t] })
    expect(done[0]!.status).toBe('done')
    const later = thread('r', [...first.messages, msg('m3', 'r', 'x@example.org', daysAgo(0), 'One more thing?')])
    const again = buildTodoList({ ...base, threads: [later], triage: [t], existing: done })
    expect(again[0]!.status).toBe('open')
    expect(again[0]!.completedAt).toBeUndefined()
  })

  it('stays done while nothing new arrives', () => {
    const th = thread('r', [msg('m1', 'r', 'x@example.org', daysAgo(2)), msg('m2', 'r', ME, daysAgo(1), 'ok', ['x@example.org'])])
    const a = buildTodoList({ ...base, threads: [th], triage: [t] })
    const b = buildTodoList({ ...base, threads: [th], triage: [t], existing: a })
    expect(b[0]!.status).toBe('done')
  })

  it('a dismissed item stays dismissed; a snoozed one returns when the time passes', () => {
    const th = thread('r', [msg('m1', 'r', 'x@example.org', daysAgo(1))])
    const open = buildTodoList({ ...base, threads: [th], triage: [t] })
    const dismissed = buildTodoList({ ...base, threads: [th], triage: [t], existing: [{ ...open[0]!, status: 'dismissed' }] })
    expect(dismissed[0]!.status).toBe('dismissed')
    const snoozed = { ...open[0]!, status: 'snoozed' as const, snoozeUntil: daysAgo(-1) }
    expect(buildTodoList({ ...base, threads: [th], triage: [t], existing: [snoozed] })[0]!.status).toBe('snoozed')
    expect(buildTodoList({ ...base, threads: [th], triage: [t], existing: [{ ...snoozed, snoozeUntil: daysAgo(1) }] })[0]!.status).toBe('open')
  })
})

describe('waiting-on items', () => {
  const t = tri('w', { needsReply: false, waitingOn: { address: 'them@example.org', name: 'Them' }, reason: 'Asked for a quote.' })

  it('lists a sent thread with no answer, scored by how long it has waited', () => {
    const th = thread('w', [msg('m1', 'w', ME, daysAgo(5), 'Can you send the quote?', ['them@example.org'])])
    const [item] = buildTodoList({ ...base, threads: [th], triage: [t] })
    expect(item!.id).toBe(waitingItemId('w'))
    expect(item!.title).toMatch(/^Waiting on Them:/)
    expect(item!.reason).toMatch(/5 days ago/)
    expect(item!.status).toBe('open')
  })

  it('completes when the other person answers', () => {
    const th = thread('w', [msg('m1', 'w', ME, daysAgo(2), 'q', ['them@example.org']), msg('m2', 'w', 'them@example.org', daysAgo(0), 'here')])
    expect(buildTodoList({ ...base, threads: [th], triage: [t] })[0]!.status).toBe('done')
  })

  it('a thread that needs nothing produces no item', () => {
    const th = thread('z', [msg('m', 'z', 'x@example.org', daysAgo(0))])
    expect(buildTodoList({ ...base, threads: [th], triage: [tri('z', { needsReply: false })] })).toEqual([])
  })
})

describe('grouping and order', () => {
  it('shows all four groups, only open items, in order', () => {
    const ths = ['a', 'b'].map((id) => thread(id, [msg(`m${id}`, id, 'x@example.org', daysAgo(0), long)]))
    const items = buildTodoList({
      ...base, threads: ths,
      triage: [tri('a', { priority: 'high', urgency: 'now' }), tri('b', { priority: 'low', urgency: 'none' })],
      resolvedThreadIds: ['b'],
    })
    const g = groupTodo(items)
    expect(g.map((x) => x.group)).toEqual(['do_now', 'schedule', 'quick_answers', 'can_wait'])
    expect(g[0]!.items.map((i: ScoredTodo) => i.id)).toEqual([replyItemId('a')])
    expect(g[3]!.items).toEqual([])
  })

  it('is deterministic', () => {
    const th = thread('a', [msg('m', 'a', 'x@example.org', daysAgo(0))])
    const args = { ...base, threads: [th], triage: [tri('a')] }
    expect(buildTodoList(args)).toEqual(buildTodoList(args))
  })
})
