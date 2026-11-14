/** Pure state for the phone layout of Email (U9): the chat sheet, swipe actions with undo, and the To do approve/edit/skip flow. */

export type SheetState = 'closed' | 'half' | 'full'
const ORDER: SheetState[] = ['closed', 'half', 'full']

/** Where a dragged sheet settles. `fraction` is how much of the screen it covers (0..1) when released; `velocity` is positive when moving up. */
export function settleSheet(fraction: number, velocity = 0): SheetState {
  if (Math.abs(velocity) > 0.5) {
    const at = fraction < 0.25 ? 0 : fraction < 0.75 ? 1 : 2
    return ORDER[Math.max(0, Math.min(2, at + (velocity > 0 ? 1 : -1)))]
  }
  if (fraction < 0.2) return 'closed'
  return fraction < 0.7 ? 'half' : 'full'
}

export type SwipeAction = 'archive' | 'later'
export const SWIPE_THRESHOLD = 80

/** A horizontal drag of `dx` px: right archives, left sets aside for later; a short drag does nothing. */
export function swipeOutcome(dx: number, threshold = SWIPE_THRESHOLD): SwipeAction | null {
  if (dx >= threshold) return 'archive'
  if (dx <= -threshold) return 'later'
  return null
}

export interface SwipeRecord { messageId: string; action: SwipeAction }
export interface SwipeLog { done: SwipeRecord[]; undone: SwipeRecord[] }
export const emptySwipeLog = (): SwipeLog => ({ done: [], undone: [] })
export function applySwipe(log: SwipeLog, rec: SwipeRecord): SwipeLog { return { done: [...log.done, rec], undone: [] } }
/** Takes back the most recent swipe; returns it so the caller can reverse it at the provider. */
export function undoSwipe(log: SwipeLog): { log: SwipeLog; undone?: SwipeRecord } {
  const last = log.done[log.done.length - 1]
  if (!last) return { log }
  return { log: { done: log.done.slice(0, -1), undone: [...log.undone, last] }, undone: last }
}

export interface TodoFlowItem { id: string; title: string }
export interface TodoFlow { queue: TodoFlowItem[]; approved: string[]; skipped: string[]; editing?: string }
export const startTodoFlow = (queue: readonly TodoFlowItem[]): TodoFlow => ({ queue: [...queue], approved: [], skipped: [] })
export const currentTodo = (f: TodoFlow): TodoFlowItem | undefined => f.queue[0]
export type TodoFlowStep = 'approve' | 'edit' | 'skip' | 'done-edit'
/** Approve and Skip move on to the next item; Edit holds the current one until `done-edit`. Nothing moves while the queue is empty. */
export function stepTodoFlow(f: TodoFlow, step: TodoFlowStep): TodoFlow {
  const cur = f.queue[0]
  if (!cur) return f
  if (step === 'edit') return { ...f, editing: cur.id }
  if (step === 'done-edit') return { ...f, editing: undefined }
  if (f.editing) return f
  const rest = f.queue.slice(1)
  return step === 'approve' ? { ...f, queue: rest, approved: [...f.approved, cur.id] } : { ...f, queue: rest, skipped: [...f.skipped, cur.id] }
}
