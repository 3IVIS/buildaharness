import { useMemo, useRef, useState } from 'react'
import type { BulkPreview, Triage } from '@buildaharness/aielia'
import {
  buildItems, describeChange, groupRows, highlightedItemIds, nextActive, rangeIds, scrollToRow, triageLabel, windowRange, type ListRow, type NavKey,
} from './message-list'
import type { Message } from '@buildaharness/aielia'

export const ROW_HEIGHT = 56

/** Aielia's mark on a message (a label or a move she made), with the action that undo reverses. */
export interface AielaMark { label: string; actionId: string }

interface Props {
  messages: readonly Message[]
  threaded?: boolean
  /** Triage by thread id. */
  triage?: Readonly<Record<string, Triage>>
  /** Aielia's marks by message id. */
  marks?: Readonly<Record<string, AielaMark>>
  onUndoMark?: (actionId: string) => void
  /** The open message; a row opens on Enter or click. */
  onOpen?: (messageId: string) => void
  /** Pending bulk change, shown in the bar above the list with the affected rows highlighted. */
  preview?: BulkPreview
  onConfirmPreview?: () => void
  onCancelPreview?: () => void
  folderName?: (id: string) => string
  /** Height of the scroll area in px (the real page measures it; tests pass it). */
  height?: number
  now?: Date
  /** Reports the selection (ids of the rows). */
  onSelectionChange?: (ids: string[]) => void
}

/**
 * The message list: a windowed list (only the rows in view are in the page, so 50,000 messages cost the same as 50), grouped Today and Earlier, flat or
 * threaded, with multi-select, keyboard navigation, a triage label and Aielia's mark (with undo) on each row, and the bulk-preview bar above.
 */
export function MessageList(p: Props): React.JSX.Element {
  const height = p.height ?? 480
  const items = useMemo(() => buildItems(p.messages, !!p.threaded), [p.messages, p.threaded])
  const rows = useMemo(() => groupRows(items, p.now ?? new Date()), [items, p.now])
  const hot = useMemo(() => highlightedItemIds(p.preview, items), [p.preview, items])
  const [scrollTop, setScrollTop] = useState(0)
  const [active, setActive] = useState<number | undefined>()
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const anchor = useRef<number | undefined>(undefined)
  const box = useRef<HTMLDivElement>(null)
  const range = windowRange(scrollTop, height, ROW_HEIGHT, rows.length)

  const select = (ids: Set<string>): void => { setSelected(ids); p.onSelectionChange?.([...ids]) }
  const itemAt = (i: number | undefined): Extract<ListRow, { kind: 'item' }> | undefined => {
    const r = i === undefined ? undefined : rows[i]
    return r?.kind === 'item' ? r : undefined
  }
  const reveal = (i: number): void => {
    const top = scrollToRow(scrollTop, height, ROW_HEIGHT, i)
    if (top !== scrollTop) { setScrollTop(top); if (box.current) box.current.scrollTop = top }
  }
  const go = (i: number | undefined, extend: boolean): void => {
    if (i === undefined) return
    setActive(i)
    reveal(i)
    if (extend) {
      const from = anchor.current ?? active ?? i
      anchor.current = from
      select(new Set(rangeIds(rows, from, i)))
    } else anchor.current = i
  }
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      go(nextActive(rows, active, e.key as NavKey), e.shiftKey)
    } else if (e.key === 'Enter') {
      const it = itemAt(active)
      if (it) p.onOpen?.(it.item.id)
    } else if (e.key === ' ') {
      e.preventDefault()
      const it = itemAt(active)
      if (it) { const s = new Set(selected); if (s.has(it.item.id)) s.delete(it.item.id); else s.add(it.item.id); select(s) }
    } else if (e.key === 'Escape') {
      select(new Set())
    } else if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      select(new Set(items.map((i) => i.id)))
    }
  }

  const affected = p.preview?.rows.length ?? 0
  return (
    <div className="mlist">
      {p.preview && (
        <div className="mlist__bar" role="region" aria-label="Bulk change preview">
          <span>
            Aielia wants to {describeChange(p.preview.change, p.folderName)} {affected} {affected === 1 ? 'message' : 'messages'}
            {p.preview.overCeiling ? ' (more than she may change in one go)' : ''}.
          </span>
          <button type="button" onClick={p.onConfirmPreview} disabled={p.preview.overCeiling || affected === 0}>Confirm</button>
          <button type="button" onClick={p.onCancelPreview}>Cancel</button>
        </div>
      )}
      {selected.size > 0 && <div className="mlist__count" aria-live="polite">{selected.size} selected</div>}
      <div
        ref={box}
        className="mlist__scroll"
        role="listbox"
        aria-label="Messages"
        aria-multiselectable="true"
        tabIndex={0}
        style={{ height, overflowY: 'auto', position: 'relative' }}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onKeyDown={onKeyDown}
      >
        <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
          {rows.slice(range.start, range.end).map((r, k) => {
            const i = range.start + k
            const style = { position: 'absolute' as const, top: i * ROW_HEIGHT, height: ROW_HEIGHT, left: 0, right: 0 }
            if (r.kind === 'header') return <div key={r.key} className="mlist__group" role="presentation" style={style}>{r.label}</div>
            const { item } = r
            const label = triageLabel(p.triage?.[item.threadId])
            const mark = p.marks?.[item.id]
            const cls = ['mlist__row', item.unread ? 'is-unread' : '', selected.has(item.id) ? 'is-selected' : '', i === active ? 'is-active' : '', hot.has(item.id) ? 'is-affected' : ''].filter(Boolean).join(' ')
            return (
              <div
                key={r.key}
                className={cls}
                role="option"
                aria-selected={selected.has(item.id)}
                aria-posinset={i + 1}
                data-id={item.id}
                style={style}
                onClick={(e) => {
                  setActive(i)
                  anchor.current = i
                  if (e.metaKey || e.ctrlKey) { const s = new Set(selected); if (s.has(item.id)) s.delete(item.id); else s.add(item.id); select(s) }
                  else if (e.shiftKey && active !== undefined) select(new Set(rangeIds(rows, active, i)))
                  else { select(new Set()); p.onOpen?.(item.id) }
                }}
              >
                <span className="mlist__from">{item.latest.from.name ?? item.latest.from.address}{item.count > 1 ? ` (${item.count})` : ''}</span>
                <span className="mlist__subject">{item.latest.subject}</span>
                {label && <span className="mlist__tag">{label}</span>}
                {mark && (
                  <span className="mlist__mark">
                    {mark.label}
                    <button type="button" aria-label={`Undo: ${mark.label}`} onClick={(e) => { e.stopPropagation(); p.onUndoMark?.(mark.actionId) }}>Undo</button>
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
