import { useRef, useState } from 'react'
import { currentTodo, settleSheet, swipeOutcome, SWIPE_THRESHOLD, type SheetState, type SwipeAction, type TodoFlow, type TodoFlowStep } from './phone-gestures'

/** The chat as a draggable sheet over a message. Drag the handle; it settles closed, half or full. */
export function PhoneSheet({ state, onState, children }: { state: SheetState; onState: (s: SheetState) => void; children: React.ReactNode }): React.JSX.Element {
  const start = useRef<{ y: number; t: number; from: number } | null>(null)
  const heightOf = (s: SheetState): number => (s === 'closed' ? 0 : s === 'half' ? 0.5 : 1)
  return (
    <section className={`phone-sheet phone-sheet--${state}`} aria-label="Aielia chat" data-state={state} hidden={state === 'closed'}>
      <div
        className="phone-sheet__handle" role="separator" aria-label="Drag to resize the chat"
        onPointerDown={(e) => { start.current = { y: e.clientY, t: e.timeStamp, from: heightOf(state) } }}
        onPointerUp={(e) => {
          const s = start.current; start.current = null
          if (!s) return
          const dy = s.y - e.clientY // up is positive
          const screen = typeof window === 'undefined' ? 800 : window.innerHeight || 800
          onState(settleSheet(Math.max(0, Math.min(1, s.from + dy / screen)), dy / Math.max(1, e.timeStamp - s.t)))
        }}
      />
      {children}
    </section>
  )
}

/** The floating Aielia button that opens the sheet. */
export function FloatingAielia({ onOpen, hidden }: { onOpen: () => void; hidden?: boolean }): React.JSX.Element | null {
  if (hidden) return null
  return <button type="button" className="phone-fab" aria-label="Ask Aielia" onClick={onOpen}>Aielia</button>
}

/** A row that can be swiped: right archives, left sets aside for later. Buttons give the same two actions without a gesture. */
export function SwipeRow({ onAction, children }: { onAction: (a: SwipeAction) => void; children: React.ReactNode }): React.JSX.Element {
  const start = useRef<{ x: number; y: number } | null>(null)
  const moved = useRef(false)
  const [dx, setDx] = useState(0)
  const cancel = (): void => { start.current = null; setDx(0) }
  return (
    <div
      className="phone-swipe" data-swipe={dx > 0 ? 'archive' : dx < 0 ? 'later' : undefined}
      style={{ ['--swipe-progress' as string]: Math.min(1, Math.abs(dx) / SWIPE_THRESHOLD) }}
      // A drag that moved is not a tap: the click the browser sends after it must not open the row.
      onClickCapture={(e) => { if (moved.current) { e.stopPropagation(); e.preventDefault(); moved.current = false } }}
    >
      <span className="phone-swipe__hint" aria-hidden="true" data-label={dx > 0 ? 'Archive' : dx < 0 ? 'Later' : ''} />
      <div
        className="phone-swipe__row" style={{ transform: dx ? `translateX(${dx}px)` : undefined }}
        onPointerDown={(e) => {
          start.current = { x: e.clientX, y: e.clientY }; moved.current = false
        }}
        onPointerMove={(e) => {
          const s = start.current
          if (!s) return
          const x = e.clientX - s.x
          if (Math.abs(x) > 10 && !moved.current) {
            moved.current = true
            // Capture only once it is a drag: capturing on press would send a plain click to the row instead of the message inside it.
            try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* not every environment supports capture */ }
          }
          setDx(x)
        }}
        onPointerUp={(e) => {
          const s = start.current
          cancel()
          if (!s) return
          const x = e.clientX - s.x
          // A mostly vertical movement is a scroll, not a swipe.
          const a = Math.abs(e.clientY - s.y) > Math.abs(x) * 0.6 ? null : swipeOutcome(x)
          if (a) onAction(a)
        }}
        onPointerCancel={cancel}
      >
        {children}
      </div>
      <span className="phone-swipe__buttons">
        <button type="button" aria-label="Archive" onClick={() => onAction('archive')}>Archive</button>
        <button type="button" aria-label="Later" onClick={() => onAction('later')}>Later</button>
      </span>
    </div>
  )
}

/** The bar above the tab bar that confirms the last swipe and offers Undo. */
export function ConfirmBar({ text, onUndo }: { text: string; onUndo: () => void }): React.JSX.Element {
  return (
    <div className="phone-confirm" role="status">
      <span>{text}</span>
      <button type="button" onClick={onUndo}>Undo</button>
    </div>
  )
}

/** The To do tab flow on a phone: one item at a time with Approve, Edit and Skip. */
export function PhoneTodoFlow({ flow, onStep, renderEditor }: { flow: TodoFlow; onStep: (s: TodoFlowStep) => void; renderEditor?: (id: string) => React.ReactNode }): React.JSX.Element {
  const cur = currentTodo(flow)
  if (!cur) return <p className="phone-todo__empty">Nothing left to review.</p>
  return (
    <div className="phone-todo">
      <p className="phone-todo__count">{flow.queue.length} to go</p>
      <h3>{cur.title}</h3>
      {flow.editing === cur.id ? (
        <>{renderEditor?.(cur.id)}<button type="button" onClick={() => onStep('done-edit')}>Done editing</button></>
      ) : (
        <div className="phone-todo__actions">
          <button type="button" onClick={() => onStep('approve')}>Approve</button>
          <button type="button" onClick={() => onStep('edit')}>Edit</button>
          <button type="button" onClick={() => onStep('skip')}>Skip</button>
        </div>
      )}
    </div>
  )
}
