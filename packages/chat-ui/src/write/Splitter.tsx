import { useRef } from 'react'

interface Props {
  /** What the handle resizes, for a screen reader: "Side panel width". */
  label: string
  axis: 'x' | 'y'
  /** +1 when dragging right (or down) makes the pane bigger, -1 when it makes it smaller. */
  grow: 1 | -1
  /** The size of the pane now, in pixels. */
  measure: () => number
  /** The room the pane may take, in pixels. */
  limits: () => { min: number; max: number }
  onSize: (px: number) => void
  /** Double-click: back to the pane's own size. */
  onReset: () => void
  className?: string
  style?: React.CSSProperties
}

const STEP = 16
const clamp = (n: number, min: number, max: number): number => Math.round(Math.min(Math.max(n, min), Math.max(min, max)))

/**
 * A line between two panes that can be grabbed and dragged to change their sizes. Arrow keys move it too (a handle that only a mouse could move
 * would shut out keyboard users), and a double-click puts the pane back to its normal size. Hidden on a phone, where the panes do not sit side by side.
 */
export function Splitter({ label, axis, grow, measure, limits, onSize, onReset, className, style }: Props): React.JSX.Element {
  const drag = useRef<{ from: number; start: number } | null>(null)
  const pos = (e: { clientX: number; clientY: number }): number => (axis === 'x' ? e.clientX : e.clientY)
  const apply = (size: number): void => { const l = limits(); onSize(clamp(size, l.min, l.max)) }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== undefined && e.button > 0) return
    e.preventDefault()
    drag.current = { from: pos(e), start: measure() }
    document.body.classList.add('write--resizing')
    const move = (m: PointerEvent): void => { if (drag.current) apply(drag.current.start + grow * (pos(m) - drag.current.from)) }
    const up = (): void => {
      drag.current = null
      document.body.classList.remove('write--resizing')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const toward = axis === 'x' ? ({ ArrowRight: 1, ArrowLeft: -1 } as Record<string, number>)[e.key] : ({ ArrowDown: 1, ArrowUp: -1 } as Record<string, number>)[e.key]
    if (toward === undefined) { if (e.key === 'Home' || e.key === 'Escape') { e.preventDefault(); onReset() } return }
    e.preventDefault()
    apply(measure() + grow * toward * STEP)
  }

  return (
    <div
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      tabIndex={0}
      title={`${label}: drag, or use the arrow keys. Double-click to reset.`}
      className={`write__split write__split--${axis}${className ? ` ${className}` : ''}`}
      style={style}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
    />
  )
}
