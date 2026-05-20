// §12 — Thin red strip shown whenever the spec has validation errors.
// Mounts between <Toolbar /> and <div className="workspace"> in App.tsx.
// Clicking it opens the Problems panel; disappears when errorCount === 0.

import { AlertCircle } from 'lucide-react'
import { useCanvasStore } from '../store'

export function ErrorBanner() {
  const { zodErrors, crossRefErrors, isProblemsOpen, toggleProblems } = useCanvasStore()
  const count = (zodErrors?.issues.length ?? 0) + crossRefErrors.length
  if (count === 0) return null

  return (
    <div
      className="error-banner"
      onClick={() => { if (!isProblemsOpen) toggleProblems() }}
      role="alert"
      aria-live="polite"
    >
      <AlertCircle size={12} />
      <span>
        <strong>{count} error{count !== 1 ? 's' : ''}</strong> in this flow · review before publishing
      </span>
      <span className="error-banner__cta">View problems →</span>
    </div>
  )
}
