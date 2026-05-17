/**
 * HitlResumePanel — appears when a LangGraph flow is paused at interrupt().
 *
 * Shows:
 *  - The prompt declared on the hitl_breakpoint node
 *  - One text field per resume_schema_fields entry
 *  - Resume button → POST /run/{jobId}/resume
 *  - Cancel button → clears HITL state without resuming
 */
import { useState } from 'react'
import { UserCheck, PlayCircle, XCircle, Loader2 } from 'lucide-react'
import { useCanvasStore } from '../store'
import { api } from '../services/api'

export function HitlResumePanel() {
  const hitlState    = useCanvasStore((s) => s.hitlState)
  const setHitlState = useCanvasStore((s) => s.setHitlState)
  const setActiveJob = useCanvasStore((s) => s.setActiveJob)
  const clearExecStats = useCanvasStore((s) => s.clearExecStats)

  const [fieldValues, setFieldValues]   = useState<Record<string, string>>({})
  const [isResuming,  setIsResuming]    = useState(false)
  const [resumeError, setResumeError]   = useState<string | null>(null)

  if (!hitlState) return null

  const { jobId, nodeId, prompt, resumeFields } = hitlState

  function setField(key: string, value: string) {
    setFieldValues((prev) => ({ ...prev, [key]: value }))
  }

  async function handleResume() {
    setIsResuming(true)
    setResumeError(null)
    try {
      // Build payload from field values — omit empty strings
      const payload: Record<string, unknown> = {}
      for (const field of resumeFields) {
        const val = fieldValues[field] ?? ''
        if (val !== '') payload[field] = val
      }
      await api.run.resume(jobId, payload)
      // Clear HITL panel — runPoller will restart when activeJobId is still set
      setHitlState(null)
      setFieldValues({})
    } catch (err) {
      setResumeError(err instanceof Error ? err.message : 'Resume failed')
    } finally {
      setIsResuming(false)
    }
  }

  function handleCancel() {
    // Discard the paused job and reset execution state
    setHitlState(null)
    setActiveJob(null)
    clearExecStats()
    setFieldValues({})
    setResumeError(null)
  }

  return (
    <aside className="hitl-panel" aria-label="Human review required">
      {/* Header */}
      <div className="hitl-panel__header">
        <span className="hitl-panel__icon">
          <UserCheck size={15} strokeWidth={1.75} />
        </span>
        <span className="hitl-panel__title">Human review required</span>
      </div>

      <div className="hitl-panel__body">
        {/* Node reference */}
        <div className="hitl-panel__node-ref">
          <span className="hitl-panel__node-label">Paused at</span>
          <code className="hitl-panel__node-id">{nodeId}</code>
        </div>

        {/* Prompt */}
        {prompt && (
          <div className="hitl-panel__prompt-block">
            <div className="hitl-panel__section-label">Prompt</div>
            <p className="hitl-panel__prompt">{prompt}</p>
          </div>
        )}

        {/* Dynamic resume fields */}
        {resumeFields.length > 0 ? (
          <div className="hitl-panel__fields">
            <div className="hitl-panel__section-label">Resume payload</div>
            {resumeFields.map((field) => (
              <div key={field} className="hitl-panel__field">
                <label className="hitl-panel__field-label" htmlFor={`hitl-${field}`}>
                  {field}
                </label>
                <input
                  id={`hitl-${field}`}
                  className="hitl-panel__field-input"
                  type="text"
                  value={fieldValues[field] ?? ''}
                  onChange={(e) => setField(field, e.target.value)}
                  placeholder={`Enter ${field}…`}
                  autoComplete="off"
                />
              </div>
            ))}
          </div>
        ) : (
          <p className="hitl-panel__no-fields">
            No input fields declared — click Resume to continue.
          </p>
        )}

        {/* Error */}
        {resumeError && (
          <div className="hitl-panel__error">{resumeError}</div>
        )}
      </div>

      {/* Actions */}
      <div className="hitl-panel__actions">
        <button
          className="hitl-panel__btn hitl-panel__btn--cancel"
          onClick={handleCancel}
          disabled={isResuming}
        >
          <XCircle size={13} strokeWidth={2} />
          Cancel run
        </button>
        <button
          className="hitl-panel__btn hitl-panel__btn--resume"
          onClick={handleResume}
          disabled={isResuming}
        >
          {isResuming
            ? <Loader2 size={13} strokeWidth={2} style={{ animation: 'spin 1s linear infinite' }} />
            : <PlayCircle size={13} strokeWidth={2} />
          }
          {isResuming ? 'Resuming…' : 'Resume flow'}
        </button>
      </div>
    </aside>
  )
}
