import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { buildTodoList, type Message, type Thread, type Triage, type TodoCorrection } from '@buildaharness/aielia'
import { TodoView, SmartFolders, ReasonStrip } from './TodoView'
import { smartFolders, dropCorrection, reasonFor } from './todo-view'

afterEach(() => { cleanup() })
const ME = 'me@example.com'
const NOW = '2026-11-13T10:00:00.000Z'
function msg(id: string, threadId: string, from: string): Message {
  return {
    id, accountId: 'a', threadId, providerId: id, folderIds: ['inbox'], from: { address: from }, to: [{ address: ME }], cc: [], subject: 's', date: NOW,
    headers: {}, textBody: 'Can you send it?', attachments: [], flags: { read: false, starred: false, draft: false },
  }
}
const th = (id: string, from: string) => {
  const m = msg(`m-${id}`, id, from)
  const t: Thread = { id, accountId: 'a', providerId: id, subject: `Subject ${id}`, messageIds: [m.id], folderIds: ['inbox'], participants: [], lastMessageAt: NOW, unread: true }
  return { thread: t, messages: [m] }
}
const tri = (threadId: string, e: Partial<Triage> = {}): Triage => ({
  threadId, category: 'person', needsReply: true, priority: 'normal', urgency: 'later', reason: 'A question.', userOverridden: false, triagedAt: NOW, ...e,
})
const items = buildTodoList({
  triage: [tri('t1', { priority: 'high', urgency: 'now' }), tri('t2', { priority: 'low', urgency: 'none' })],
  threads: [th('t1', 'a@x.com'), th('t2', 'b@x.com')], userAddresses: [ME], now: () => NOW,
})

describe('To do view', () => {
  it('shows the four groups with a reason on each item', () => {
    render(<TodoView items={items} />)
    for (const l of ['Do now', 'Schedule', 'Quick answers', 'Can wait']) expect(screen.getByRole('region', { name: l })).toBeTruthy()
    for (const i of items) { expect(i.reason.length).toBeGreaterThan(0); expect(screen.getAllByText(i.reason).length).toBeGreaterThan(0) }
  })
  it('smart folders count the open items by kind', () => {
    const f = smartFolders(items)
    expect(f.map((x) => x.name)).toEqual(['To do', 'Needs reply', 'Waiting on others'])
    expect(f[0]!.count).toBe(items.length)
    expect(f[1]!.count + f[2]!.count).toBe(f[0]!.count)
    render(<SmartFolders items={items} onSelect={() => {}} />)
    expect(screen.getByText(`To do (${items.length})`)).toBeTruthy()
  })
  it('the reason strip shows the reason for the open thread and nothing for others', () => {
    const i = items.find((x) => x.threadId === 't1')!
    expect(reasonFor(items, 't1')?.text).toBe(i.reason)
    const { container } = render(<ReasonStrip items={items} threadId="nope" />)
    expect(container.textContent).toBe('')
    render(<ReasonStrip items={items} threadId="t1" />)
    expect(screen.getByRole('note').textContent).toContain(i.reason)
  })
  it('a drag to another group is recorded as a move correction', () => {
    const onMove = vi.fn()
    render(<TodoView items={items} onMove={onMove} />)
    const item = items.find((x) => x.group === 'do_now')!
    const data: Record<string, string> = {}
    const dt = { setData: (k: string, v: string) => { data[k] = v }, getData: (k: string) => data[k] ?? '' }
    fireEvent.dragStart(document.querySelector(`[data-item="${item.id}"]`)!, { dataTransfer: dt })
    fireEvent.drop(screen.getByRole('region', { name: 'Can wait' }), { dataTransfer: dt })
    expect(onMove).toHaveBeenCalledWith(item, 'can_wait')
    const corr: TodoCorrection[] = dropCorrection([], item, 'can_wait', NOW)
    expect(corr).toEqual([{ threadId: item.threadId, kind: 'move', group: 'can_wait', at: NOW }])
    const moved = buildTodoList({ triage: [tri('t1', { priority: 'high', urgency: 'now' })], threads: [th('t1', 'a@x.com')], userAddresses: [ME], corrections: corr, now: () => NOW })
    expect(moved[0]!.group).toBe('can_wait')
    expect(moved[0]!.reason).toContain('You moved this')
    expect(dropCorrection([], item, item.group, NOW)).toEqual([])
  })
})
