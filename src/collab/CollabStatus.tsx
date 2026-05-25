import { useState, useEffect, useRef } from 'react'
import { useCanvasStore } from '../store'
import { useAwareness } from './useAwareness'

type ConnStatus = 'connecting' | 'reconnecting' | 'connected' | 'disconnected'

export function CollabStatus() {
  const wsProvider = useCanvasStore((s) => s._collabWsProvider)
  const awareness  = useCanvasStore((s) => s._collabAwareness)

  const [status, setStatus]             = useState<ConnStatus>('connecting')
  const [disconnectedSince, setDisconnectedSince] = useState<number | null>(null)
  const [elapsed, setElapsed]           = useState(0)
  const connectCount                    = useRef(0)

  // Always call useAwareness — pass null when collab is inactive (returns [])
  const peers = useAwareness(awareness)

  // Subscribe to wsProvider status events — no-op when wsProvider is null
  useEffect(() => {
    if (!wsProvider) return
    function onStatus({ status: s }: { status: string }) {
      if (s === 'connected') {
        connectCount.current += 1
        setStatus('connected')
        setDisconnectedSince(null)
      } else if (s === 'disconnected') {
        // Fix #14 — distinguish first-connect failure from mid-session loss
        setStatus(connectCount.current > 0 ? 'reconnecting' : 'disconnected')
        setDisconnectedSince((prev) => prev ?? Date.now())
      }
    }
    wsProvider.on('status', onStatus)
    return () => wsProvider.off('status', onStatus)
  }, [wsProvider])

  // Elapsed timer while disconnected or reconnecting
  useEffect(() => {
    if (status !== 'disconnected' && status !== 'reconnecting') return
    const id = setInterval(() => {
      setElapsed(disconnectedSince ? Math.floor((Date.now() - disconnectedSince) / 1000) : 0)
    }, 1000)
    return () => clearInterval(id)
  }, [status, disconnectedSince])

  // Not in collab mode — render nothing
  if (!wsProvider) return null

  const dot: Record<ConnStatus, string> = {
    connecting:   '#f59e0b',
    reconnecting: '#f59e0b',
    connected:    '#22c55e',
    disconnected: '#ef4444',
  }
  const label: Record<ConnStatus, string> = {
    connecting:   'Connecting…',
    reconnecting: `Reconnecting… (${elapsed}s)`,
    connected:    `${peers.length + 1} online`,
    disconnected: `Offline (${elapsed}s)`,
  }

  return (
    <div style={{
      position: 'absolute', top: 12, right: 12, zIndex: 10,
      display: 'flex', alignItems: 'center', gap: 6,
      background: 'var(--bg-raised)', border: '1px solid var(--border)',
      borderRadius: 6, padding: '4px 8px', fontSize: 12,
      color: 'var(--text-secondary)', pointerEvents: 'none',
    }}>
      <span style={{
        width: 7, height: 7, borderRadius: '50%',
        background: dot[status],
        boxShadow: status === 'connected' ? `0 0 4px ${dot[status]}` : 'none',
      }} />
      {label[status]}
    </div>
  )
}
