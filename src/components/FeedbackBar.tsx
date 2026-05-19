/**
 * FeedbackBar — thumbs-up / thumbs-down feedback widget.
 *
 * Rendered inside the run-complete toast in App.tsx.  On click it calls
 * POST /eval/feedback with the last completed job_id, then shows a filled
 * icon to indicate the signal was recorded.
 *
 * Design decisions:
 *  - Optimistic UI: mark as submitted immediately; API errors are swallowed
 *    silently (feedback is best-effort, not blocking).
 *  - Once submitted, both buttons become inert (no double-submit).
 *  - No comment field in v1 — keeps the toast footprint minimal.
 */
import { useState } from 'react'
import { ThumbsUp, ThumbsDown } from 'lucide-react'
import { api } from '../services/api'
import { useCanvasStore } from '../store'

export function FeedbackBar() {
  const lastCompletedJobId  = useCanvasStore((s) => s.lastCompletedJobId)
  const feedbackSubmitted   = useCanvasStore((s) => s.feedbackSubmitted)
  const setFeedbackSubmitted = useCanvasStore((s) => s.setFeedbackSubmitted)

  // Local loading state so the buttons briefly dim while the request flies.
  const [pending, setPending] = useState(false)

  if (!lastCompletedJobId) return null

  async function handleFeedback(value: 1 | -1) {
    if (feedbackSubmitted || pending || !lastCompletedJobId) return
    setPending(true)
    // Optimistic: mark submitted before the network round-trip completes so
    // the UI feels instant.  The API call is fire-and-forget.
    setFeedbackSubmitted()
    try {
      await api.eval.feedback(lastCompletedJobId, value)
    } catch {
      // Feedback is best-effort — silently ignore network or server errors.
    } finally {
      setPending(false)
    }
  }

  const iconSize   = 13
  const iconStroke = 1.75
  const base: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 4,
    marginLeft: 8, paddingLeft: 8,
    borderLeft: '0.5px solid rgba(255,255,255,0.08)',
  }
  const btnStyle = (active: boolean): React.CSSProperties => ({
    background: 'none',
    border: 'none',
    cursor: feedbackSubmitted || pending ? 'default' : 'pointer',
    padding: '2px 3px',
    borderRadius: 4,
    display: 'flex', alignItems: 'center',
    opacity: pending ? 0.5 : 1,
    color: active ? 'var(--rt-full)' : 'var(--text-tertiary)',
    transition: 'color 0.15s, opacity 0.15s',
  })

  if (feedbackSubmitted) {
    return (
      <div style={base} title="Feedback recorded — thank you">
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)', userSelect: 'none' }}>
          ✓ thanks
        </span>
      </div>
    )
  }

  return (
    <div style={base} title="Rate this run">
      <span style={{ fontSize: 11, color: 'var(--text-tertiary)', userSelect: 'none' }}>
        rate:
      </span>
      <button
        style={btnStyle(false)}
        onClick={() => handleFeedback(1)}
        title="Good result"
        aria-label="Thumbs up — good result"
      >
        <ThumbsUp size={iconSize} strokeWidth={iconStroke} />
      </button>
      <button
        style={btnStyle(false)}
        onClick={() => handleFeedback(-1)}
        title="Bad result"
        aria-label="Thumbs down — bad result"
      >
        <ThumbsDown size={iconSize} strokeWidth={iconStroke} />
      </button>
    </div>
  )
}
