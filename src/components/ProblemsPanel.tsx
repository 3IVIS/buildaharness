import { AlertCircle, AlertTriangle, CheckCircle, ChevronUp } from 'lucide-react'
import { useCanvasStore } from '../store'

export function ProblemsPanel() {
  const { zodErrors, crossRefErrors, isProblemsOpen, toggleProblems, selectNode } = useCanvasStore()

  const zodIssues   = zodErrors?.issues ?? []
  const totalErrors = zodIssues.length + crossRefErrors.length

  if (!isProblemsOpen) return null

  return (
    <div className="problems-panel">
      <div className="problems-panel__header" onClick={toggleProblems}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 500 }}>
          {totalErrors > 0
            ? <AlertCircle size={12} style={{ color: '#ef4444' }} />
            : <CheckCircle size={12} style={{ color: '#22c55e' }} />
          }
          {totalErrors > 0 ? `${totalErrors} problem${totalErrors > 1 ? 's' : ''}` : 'No problems'}
        </span>
        {/* Fix: was always ChevronDown — now shows ChevronUp when panel is open (it is, since we guard above) */}
        <ChevronUp size={12} style={{ color: 'var(--text-tertiary)' }} />
      </div>

      <div className="problems-panel__list">
        {zodIssues.map((issue, i) => (
          <div key={`z-${i}`} className="problem-row">
            <AlertCircle size={11} style={{ color: '#ef4444', flexShrink: 0, marginTop: 1 }} />
            <div style={{ flex: 1 }}>
              <span style={{ color: '#f87171', fontSize: 11 }}>{issue.message}</span>
              <span style={{ color: 'var(--text-tertiary)', fontSize: 10, marginLeft: 8, fontFamily: 'var(--font-mono)' }}>
                {issue.path.join(' › ')}
              </span>
            </div>
            <span className="problem-row__source">zod</span>
          </div>
        ))}

        {crossRefErrors.map((err, i) => {
          // Fix: warnings (severity='warning') show AlertTriangle in amber, errors show AlertCircle in red.
          const isWarning = err.severity === 'warning'
          return (
            <div key={`c-${i}`} className="problem-row" style={{ cursor: err.nodeId ? 'pointer' : 'default' }}
              onClick={() => err.nodeId && selectNode(err.nodeId)}>
              {isWarning
                ? <AlertTriangle size={11} style={{ color: '#f59e0b', flexShrink: 0, marginTop: 1 }} />
                : <AlertCircle   size={11} style={{ color: '#f97316', flexShrink: 0, marginTop: 1 }} />
              }
              <div style={{ flex: 1 }}>
                {err.nodeId && (
                  <span style={{ color: isWarning ? '#fcd34d' : '#fb923c', fontSize: 10, fontFamily: 'var(--font-mono)', marginRight: 6 }}>{err.nodeId}</span>
                )}
                <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>{err.message}</span>
              </div>
              <span className="problem-row__source">{isWarning ? 'warning' : 'cross-ref'}</span>
            </div>
          )
        })}

        {totalErrors === 0 && (
          <div style={{ padding: '10px 14px', color: 'var(--text-tertiary)', fontSize: 11 }}>
            Spec is valid — no problems found.
          </div>
        )}
      </div>
    </div>
  )
}
