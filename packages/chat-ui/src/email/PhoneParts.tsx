import { useRef, useState } from 'react'
import { currentTodo, settleSheet, swipeOutcome, type SheetState, type SwipeAction, type TodoFlow, type TodoFlowStep } from './phone-gestures'

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
  const x0 = useRef<number | null>(null)
  const [dx, setDx] = useState(0)
  return (
    <div
      className="phone-swipe" style={{ transform: dx ? `translateX(${dx}px)` : undefined }}
      onPointerDown={(e) => { x0.current = e.clientX }}
      onPointerMove={(e) => { if (x0.current !== null) setDx(e.clientX - x0.current) }}
      onPointerUp={(e) => {
        const a = x0.current === null ? null : swipeOutcome(e.clientX - x0.current)
        x0.current = null; setDx(0)
        if (a) onAction(a)
      }}
      onPointerCancel={() => { x0.current = null; setDx(0) }}
    >
      {children}
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
