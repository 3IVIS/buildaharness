import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import type { BulkPreview, Message } from '@buildaharness/aielia'
import { MessageList, ROW_HEIGHT } from './MessageList'
import { buildItems, groupRows, windowRange, nextActive, triageLabel } from './message-list'

const NOW = new Date('2026-11-14T12:00:00Z')
const msg = (n: number, over: Partial<Message> = {}): Message => ({
  id: `m${n}`, accountId: 'a', threadId: `t${n}`, providerId: `p${n}`, folderIds: ['inbox'],
  from: { address: `s${n}@x.test`, name: `Sender ${n}` }, to: [], cc: [], subject: `Subject ${n}`,
  date: new Date(NOW.getTime() - n * 3_600_000).toISOString(), headers: {}, textBody: '', attachments: [],
  flags: { read: n % 2 === 0, starred: false, draft: false }, ...over,
})
const many = (n: number): Message[] => Array.from({ length: n }, (_, i) => msg(i))

describe('message list model', () => {
  it('groups Today then Earlier, newest first', () => {
    const rows = groupRows(buildItems([msg(1), msg(40), msg(0)], false), NOW)
    expect(rows.map((r) => (r.kind === 'header' ? r.label : r.item.id))).toEqual(['Today', 'm0', 'm1', 'Earlier', 'm40'])
  })
  it('threads: one row per thread with a count and unread if any is unread', () => {
    const items = buildItems([msg(1, { threadId: 'T' }), msg(2, { threadId: 'T' }), msg(3)], true)
    expect(items).toHaveLength(2)
    const t = items.find((i) => i.threadId === 'T')!
    expect(t.count).toBe(2)
    expect(t.unread).toBe(true)
    expect(t.messageIds.sort()).toEqual(['m1', 'm2'])
  })
  it('threads: a Sent copy under another thread id joins its conversation through in-reply-to', () => {
    const a = msg(1, { threadId: 'T1', headers: { 'message-id': '<one@x.test>' } })
    const b = msg(2, { threadId: 'T2', headers: { 'message-id': '<two@x.test>', 'in-reply-to': '<one@x.test>' }, subject: 'A different subject' })
    const items = buildItems([a, b], true)
    expect(items).toHaveLength(1)
    expect(items[0]!.count).toBe(2)
    expect(buildItems([a, b], false)).toHaveLength(2)
  })
  it('windowRange is bounded by the viewport', () => {
    const r = windowRange(0, 480, ROW_HEIGHT, 50_000)
    expect(r.end - r.start).toBeLessThan(30)
    expect(windowRange(0, 480, ROW_HEIGHT, 0)).toEqual({ start: 0, end: 0 })
  })
  it('keyboard movement skips headers and clamps', () => {
    const rows = groupRows(buildItems([msg(1), msg(40)], false), NOW) // 0 header,1 item,2 header,3 item
    expect(nextActive(rows, undefined, 'ArrowDown')).toBe(1)
    expect(nextActive(rows, 1, 'ArrowDown')).toBe(3)
    expect(nextActive(rows, 3, 'ArrowDown')).toBe(3)
    expect(nextActive(rows, 3, 'ArrowUp')).toBe(1)
    expect(nextActive(rows, 1, 'ArrowUp')).toBe(1)
    expect(nextActive(rows, 1, 'End')).toBe(3)
    expect(nextActive(rows, 3, 'Home')).toBe(1)
  })
  it('triage label prefers needs reply', () => {
    const t = { threadId: 't', category: 'newsletter', needsReply: true, priority: 'normal', urgency: 'none', reason: 'r', userOverridden: false, triagedAt: NOW.toISOString() } as const
    expect(triageLabel(t)).toBe('Needs reply')
    expect(triageLabel({ ...t, needsReply: false })).toBe('Newsletter')
    expect(triageLabel(undefined)).toBeUndefined()
  })
})

describe('MessageList', () => {
  it('renders a bounded number of rows for 50,000 messages, and more after scrolling', () => {
    render(<MessageList messages={many(50_000)} now={NOW} height={480} />)
    const list = screen.getByRole('listbox', { name: 'Messages' })
    const n = within(list).getAllByRole('option').length
    expect(n).toBeGreaterThan(5)
    expect(n).toBeLessThan(40)
    fireEvent.scroll(list, { target: { scrollTop: 20_000 * ROW_HEIGHT } })
    const after = within(list).getAllByRole('option')
    expect(after.length).toBeLessThan(40)
    expect(after.some((o) => o.getAttribute('data-id') === 'm19995')).toBe(true)
  })

  it('moves with arrow keys, opens on Enter, selects with Space and extends with Shift', () => {
    const onOpen = vi.fn()
    const onSel = vi.fn()
    render(<MessageList messages={many(10)} now={NOW} onOpen={onOpen} onSelectionChange={onSel} />)
    const list = screen.getByRole('listbox')
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    fireEvent.keyDown(list, { key: 'Enter' })
    expect(onOpen).toHaveBeenLastCalledWith('m1')
    fireEvent.keyDown(list, { key: ' ' })
    expect(onSel).toHaveBeenLastCalledWith(['m1'])
    fireEvent.keyDown(list, { key: 'ArrowDown', shiftKey: true })
    fireEvent.keyDown(list, { key: 'ArrowDown', shiftKey: true })
    expect(onSel.mock.lastCall![0].sort()).toEqual(['m1', 'm2', 'm3'])
    expect(screen.getByText('3 selected')).toBeTruthy()
    fireEvent.keyDown(list, { key: 'Escape' })
    expect(screen.queryByText(/selected/)).toBeNull()
    fireEvent.keyDown(list, { key: 'a', ctrlKey: true })
    expect(screen.getByText('10 selected')).toBeTruthy()
  })

  it('shows the triage label and Aielia mark, and undo calls back with the action', () => {
    const onUndo = vi.fn()
    render(
      <MessageList
        messages={many(3)} now={NOW} onUndoMark={onUndo}
        triage={{ t0: { threadId: 't0', category: 'person', needsReply: true, priority: 'high', urgency: 'now', reason: 'asked a question', userOverridden: false, triagedAt: NOW.toISOString() } }}
        marks={{ m1: { label: 'Moved to Receipts', actionId: 'act-1' } }}
      />,
    )
    expect(screen.getByText('Needs reply')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Undo: Moved to Receipts' }))
    expect(onUndo).toHaveBeenCalledWith('act-1')
  })

  it('the preview bar highlights the affected rows, confirms and cancels', () => {
    const st = { folderIds: ['inbox'], read: false, starred: false }
    const preview: BulkPreview = {
      change: { type: 'move', folderId: 'archive' },
      rows: [{ messageId: 'm1', subject: 's', before: st, after: { ...st, folderIds: ['archive'] } }, { messageId: 'm2', subject: 's', before: st, after: { ...st, folderIds: ['archive'] } }],
      unchanged: [], missing: [], overCeiling: false, needsConfirmation: true,
    }
    const ok = vi.fn()
    const no = vi.fn()
    render(<MessageList messages={many(5)} now={NOW} preview={preview} onConfirmPreview={ok} onCancelPreview={no} folderName={(id) => (id === 'archive' ? 'Archive' : id)} />)
    const bar = screen.getByRole('region', { name: 'Bulk change preview' })
    expect(bar.textContent).toContain('move to Archive 2 messages')
    const hot = screen.getAllByRole('option').filter((o) => o.className.includes('is-affected')).map((o) => o.getAttribute('data-id'))
    expect(hot.sort()).toEqual(['m1', 'm2'])
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(ok).toHaveBeenCalledOnce()
    expect(no).toHaveBeenCalledOnce()
  })

  it('cannot confirm a preview over the ceiling', () => {
    const preview: BulkPreview = { change: { type: 'read', read: true }, rows: [], unchanged: [], missing: [], overCeiling: true, needsConfirmation: true }
    render(<MessageList messages={many(2)} now={NOW} preview={preview} />)
    expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
