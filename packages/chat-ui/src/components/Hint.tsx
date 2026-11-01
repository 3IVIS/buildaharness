import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './hint.css'

const TIP_MAX_WIDTH = 240
const EDGE = 8

/**
 * A small "?" that explains itself on hover, keyboard focus or a tap. The explanation is drawn on the page itself (not inside the row), so no
 * panel or scrolling area can clip it, and it is kept inside the window. A click is swallowed so a "?" inside a label never ticks its box.
 */
export function Hint({ text }: { text: string }): React.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null)
  const [tip, setTip] = useState<{ left: number; top: number; above: boolean } | null>(null)

  function show(): void {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    const width = Math.min(TIP_MAX_WIDTH, window.innerWidth - 2 * EDGE)
    const left = Math.max(EDGE, Math.min(r.left - 6, window.innerWidth - width - EDGE))
    const above = r.bottom + 80 > window.innerHeight && r.top > 80
    setTip({ left, top: above ? r.top - 6 : r.bottom + 6, above })
  }
  const hide = (): void => setTip(null)

  useEffect(() => {
    if (!tip) return
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') hide() }
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', hide, true)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('scroll', hide, true) }
  }, [tip])

  return (
    <span
      ref={ref}
      className="hint"
      tabIndex={0}
      role="img"
      aria-label={text}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (tip) hide(); else show() }}
    >
      ?
      {tip && createPortal(
        <span className="hint__tip" role="tooltip" style={{ left: tip.left, top: tip.top, maxWidth: Math.min(TIP_MAX_WIDTH, window.innerWidth - 2 * EDGE), transform: tip.above ? 'translateY(-100%)' : undefined }}>{text}</span>,
        document.body,
      )}
    </span>
  )
}
