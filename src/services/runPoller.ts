/**
 * useRunPoller — watches activeJobId in the canvas store and polls
 * GET /run/{jobId} every 800ms, pushing per-node status updates into
 * execStats so the canvas overlay stays live during execution.
 *
 * Lives at App level so polling continues even if the library panel is closed.
 */
import { useEffect, useRef } from 'react'
import { useCanvasStore } from '../store'
import { api } from './api'

export function useRunPoller() {
  const activeJobId      = useCanvasStore((s) => s.activeJobId)
  const setNodeExecStat  = useCanvasStore((s) => s.setNodeExecStat)
  const clearExecStats   = useCanvasStore((s) => s.clearExecStats)
  const setActiveJob     = useCanvasStore((s) => s.setActiveJob)

  // Track which events we've already processed (by index into node_events array)
  const processedIdx = useRef(0)

  useEffect(() => {
    if (!activeJobId) return

    // Reset
    clearExecStats()
    processedIdx.current = 0

    const interval = setInterval(async () => {
      try {
        const job = await api.run.status(activeJobId)

        // Process only new events since last poll
        const events = job.node_events ?? []
        const newEvents = events.slice(processedIdx.current)
        processedIdx.current = events.length

        // Reconcile: last event per node_id wins for status
        for (const ev of newEvents) {
          setNodeExecStat(ev.node_id, {
            status: ev.status as 'pending' | 'running' | 'done' | 'error',
            ms:     ev.ms ?? undefined,
          })
        }

        if (job.status === 'done' || job.status === 'error') {
          clearInterval(interval)
          setActiveJob(null)
        }
      } catch {
        clearInterval(interval)
        setActiveJob(null)
      }
    }, 800)

    return () => clearInterval(interval)
  }, [activeJobId, setNodeExecStat, clearExecStats, setActiveJob])
}
