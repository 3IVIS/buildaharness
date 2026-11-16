import type { BulkPreview, EmailChange, Message, Triage } from '@buildaharness/aielia'

/** One line of the message list: a message, or the thread it stands for when the list is threaded. */
export interface ListItem {
  /** The id the row stands for: the latest message's id (flat) or the thread's latest message (threaded). */
  id: string
  threadId: string
  latest: Message
  /** How many messages the row stands for (1 when flat). */
  count: number
  unread: boolean
  /** Ids of every message the row stands for; a bulk change on the row applies to all of them. */
  messageIds: string[]
}

export type ListRow = { kind: 'header'; key: string; label: string } | { kind: 'item'; key: string; item: ListItem }

const byNewest = (a: Message, b: Message): number => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? -1 : 1)

/** Newest first. Threaded: one item per thread, placed by its latest message. */
export function buildItems(messages: readonly Message[], threaded: boolean): ListItem[] {
  const sorted = [...messages].sort(byNewest)
  if (!threaded) return sorted.map((m) => ({ id: m.id, threadId: m.threadId, latest: m, count: 1, unread: !m.flags.read, messageIds: [m.id] }))
  const byThread = new Map<string, Message[]>()
  for (const m of sorted) {
    const g = byThread.get(m.threadId)
    if (g) g.push(m)
    else byThread.set(m.threadId, [m])
  }
  return [...byThread.values()].map((g) => ({
    id: g[0].id, threadId: g[0].threadId, latest: g[0], count: g.length, unread: g.some((m) => !m.flags.read), messageIds: g.map((m) => m.id),
  }))
}

const dayKey = (iso: string): string => iso.slice(0, 10)

/** Today, then Earlier. Header rows are part of the row sequence so the window counts them. */
export function groupRows(items: readonly ListItem[], now: Date): ListRow[] {
  const today = dayKey(now.toISOString())
  const rows: ListRow[] = []
  let current: string | undefined
  for (const item of items) {
    const g = dayKey(item.latest.date) >= today ? 'Today' : 'Earlier'
    if (g !== current) { rows.push({ kind: 'header', key: `h:${g}`, label: g }); current = g }
    rows.push({ kind: 'item', key: item.id, item })
  }
  return rows
}

export interface WindowRange { start: number; end: number }

/** The rows to render for a scroll position: the visible ones plus a little over. Bounded by the viewport, not by the total. */
export function windowRange(scrollTop: number, viewport: number, rowHeight: number, total: number, overscan = 6): WindowRange {
  if (total <= 0 || rowHeight <= 0) return { start: 0, end: 0 }
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight)
  const last = Math.ceil((Math.max(0, scrollTop) + Math.max(0, viewport)) / rowHeight)
  return { start: Math.max(0, first - overscan), end: Math.min(total, last + overscan) }
}

/** Keeps a row in view: the scrollTop that shows row `index` with the least movement. */
export function scrollToRow(scrollTop: number, viewport: number, rowHeight: number, index: number): number {
  const top = index * rowHeight
  if (top < scrollTop) return top
  if (top + rowHeight > scrollTop + viewport) return top + rowHeight - viewport
  return scrollTop
}

/** Index of the item rows within `rows`, in order; keyboard movement skips headers. */
export function itemIndices(rows: readonly ListRow[]): number[] {
  const out: number[] = []
  rows.forEach((r, i) => { if (r.kind === 'item') out.push(i) })
  return out
}

export type NavKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'

/** The next active row index (into `rows`) for a navigation key, skipping header rows. */
export function nextActive(rows: readonly ListRow[], active: number | undefined, key: NavKey): number | undefined {
  const idx = itemIndices(rows)
  if (idx.length === 0) return undefined
  if (key === 'Home') return idx[0]
  if (key === 'End') return idx[idx.length - 1]
  const pos = active === undefined ? -1 : idx.indexOf(active)
  if (key === 'ArrowDown') return idx[Math.min(idx.length - 1, pos + 1)]
  return idx[Math.max(0, pos < 0 ? 0 : pos - 1)]
}

/** Ids of the item rows between two row indexes, inclusive (a shift-extended selection). */
export function rangeIds(rows: readonly ListRow[], a: number, b: number): string[] {
  const [lo, hi] = a <= b ? [a, b] : [b, a]
  const out: string[] = []
  for (let i = lo; i <= hi; i++) { const r = rows[i]; if (r?.kind === 'item') out.push(r.item.id) }
  return out
}

/** The word on a row for its triage: the one thing the user most needs to know. */
export function triageLabel(t: Triage | undefined): string | undefined {
  if (!t) return undefined
  if (t.needsReply) return 'Needs reply'
  if (t.waitingOn) return 'Waiting'
  if (t.priority === 'high') return 'Important'
  return t.category === 'person' || t.category === 'other' ? undefined : t.category[0].toUpperCase() + t.category.slice(1)
}

/** A sentence for what a change does, for the bulk-preview bar and for Aielia's marks. */
export function describeChange(c: EmailChange, folderName: (id: string) => string = (id) => id): string {
  switch (c.type) {
    case 'move': return `move to ${folderName(c.folderId)}`
    case 'label': return `${c.add ? 'add' : 'remove'} the label ${folderName(c.folderId)}`
    case 'flag': return c.starred ? 'star' : 'remove the star from'
    case 'read': return c.read ? 'mark as read' : 'mark as unread'
  }
}

/** Ids of the list items a preview touches (a threaded row is touched when any of its messages is). */
export function highlightedItemIds(preview: BulkPreview | undefined, items: readonly ListItem[]): Set<string> {
  const out = new Set<string>()
  if (!preview) return out
  const touched = new Set(preview.rows.map((r) => r.messageId))
  for (const it of items) if (it.messageIds.some((id) => touched.has(id))) out.add(it.id)
  return out
}
