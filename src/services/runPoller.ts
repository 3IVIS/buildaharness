/**
 * useRunPoller — watches activeJobId and polls GET /run/{jobId} every 800ms,
 * pushing per-node status updates (status, ms, tokens) into execStats so the
 * canvas overlay stays live during execution.
 *
 * Also picks up:
 *   trace_id  → setActiveExecutionTrace() so langfuse.ts links canvas events
 *               to the execution trace
 *   trace_url → setTraceUrl() so App.tsx can render a "View trace" link
 *
 * On job completion (done or error):
 *   - Sets lastCompletedJobId so FeedbackBar can submit user thumbs signals.
 *   - Fetches GET /eval/scores?trace_id=X (if trace_id is available) and stores
 *     the result in evalScores for the per-node quality badge arcs on ExecBadge.
 *     Errors are silently swallowed — quality badges are best-effort.
 *
 * Terminal states:
 *   done   → clears activeJobId, stops polling, keeps traceUrl for the link
 *   error  → clears activeJobId, stops polling
 *   paused → stops polling, populates hitlState for the HITL resume panel
 *
 * Fix: after HITL resume the user calls api.run.resume() which sets the job
 * back to "running", then clears hitlState. The old interval was stopped when
 * the job paused, and activeJobId hadn't changed, so the useEffect never
 * re-fired — polling was permanently dead for the rest of the run.
 *
 * Solution: include hitlState in the dependency array. When hitlState is cleared
 * (resume or cancel) the effect re-runs. If activeJobId is still set (resume
 * case) a fresh interval starts. If activeJobId was also cleared (cancel case)
 * the early-return guard fires and no interval starts.
 */
import { useEffect, useRef } from 'react'
import { useCanvasStore } from '../store'
import { api } from './api'
import { setActiveExecutionTrace } from './langfuse'

export function useRunPoller() {
  const activeJobId          = useCanvasStore((s) => s.activeJobId)
  const hitlState            = useCanvasStore((s) => s.hitlState)   // Fix: add to deps
  const setNodeExecStat      = useCanvasStore((s) => s.setNodeExecStat)
  const clearExecStats       = useCanvasStore((s) => s.clearExecStats)
  const setActiveJob         = useCanvasStore((s) => s.setActiveJob)
  const setHitlState         = useCanvasStore((s) => s.setHitlState)
  const setTraceUrl          = useCanvasStore((s) => s.setTraceUrl)
  const setJobError          = useCanvasStore((s) => s.setJobError)
  const setLastCompleted     = useCanvasStore((s) => s.setLastCompleted)
  const setEvalScores        = useCanvasStore((s) => s.setEvalScores)

  // Track which trace we've already wired (avoid redundant calls)
  const wiredTraceId = useRef<string | null>(null)
  const processedIdx = useRef(0)

  useEffect(() => {
    // Don't start a new poll interval while paused — the HITL panel is open.
    // When hitlState is cleared (resume or cancel) this effect re-runs.
    if (!activeJobId || hitlState) return

    clearExecStats()
    setJobError(null)   // clear any error from a previous run
    processedIdx.current = 0
    wiredTraceId.current = null

    const interval = setInterval(async () => {
      try {
        const job = await api.run.status(activeJobId)

        // ── Wire Langfuse trace context once we have a trace_id ───────────
        if (job.trace_id && job.trace_id !== wiredTraceId.current) {
          wiredTraceId.current = job.trace_id
          setActiveExecutionTrace(job.trace_id)
        }
        if (job.trace_url) {
          setTraceUrl(job.trace_url)
        }

        // ── Process new node events ───────────────────────────────────────
        const events    = job.node_events ?? []
        const newEvents = events.slice(processedIdx.current)
        processedIdx.current = events.length

        for (const ev of newEvents) {
          setNodeExecStat(ev.node_id, {
            status:       ev.status as 'pending' | 'running' | 'paused' | 'done' | 'error',
            ms:           ev.ms            ?? undefined,
            tokens:       ev.tokens        ?? undefined,
            errorMessage: ev.error_message ?? undefined,   // from adapter node error
          })
        }

        // ── Terminal states ───────────────────────────────────────────────
        if (job.status === 'done' || job.status === 'error') {
          clearInterval(interval)
          setActiveJob(null)
          setHitlState(null)
          setActiveExecutionTrace(null)

          // Surface the job-level error string (compile error, network failure,
          // adapter crash) so the RunDrawer can display it even when no specific
          // node error_message is available.
          if (job.status === 'error' && job.error) {
            setJobError(job.error)
          }

          // Record which job just finished so FeedbackBar can reference it.
          setLastCompleted(activeJobId)

          // Fetch eval scores from Langfuse and store them for quality badges.
          // Best-effort: errors are swallowed — badges degrade to no-ops gracefully.
          if (job.trace_id) {
            api.eval.scores(job.trace_id)
              .then((res) => setEvalScores(res.data ?? []))
              .catch(() => { /* scores are optional — never block on this */ })
          }

          // Keep traceUrl set so the "View trace" link persists after run
          return
        }

        if (job.status === 'paused' && job.hitl_state) {
          clearInterval(interval)
          setHitlState({
            jobId:        activeJobId,
            nodeId:       job.hitl_state.node_id,
            prompt:       job.hitl_state.prompt,
            resumeFields: job.hitl_state.resume_schema_fields,
          })
          setActiveExecutionTrace(null)
          return
        }
      } catch {
        clearInterval(interval)
        setActiveJob(null)
        setHitlState(null)
        setActiveExecutionTrace(null)
      }
    }, 800)

    return () => clearInterval(interval)
  // Fix: hitlState added so clearing it (after resume) re-triggers the effect
  // and restarts polling. Without this the interval stays dead after HITL resume.
  }, [activeJobId, hitlState, setNodeExecStat, clearExecStats, setActiveJob, setHitlState, setTraceUrl, setJobError, setLastCompleted, setEvalScores])
}
