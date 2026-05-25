/**
 * collab/useAwareness.ts
 *
 * React hook that returns a live list of remote peers from a Yjs Awareness
 * instance. Excludes the local client.
 *
 * PeerState shape mirrors what CollabCursors.tsx and CollabStatus.tsx expect.
 */
import { useState, useEffect } from 'react'
import type { Awareness } from 'y-protocols/awareness'

export interface CollabUser {
  name:  string
  color: string
}

export interface CollabCursor {
  x: number
  y: number
}

export interface PeerState {
  clientId: number
  user?:    CollabUser
  cursor?:  CollabCursor
}

/**
 * Returns the current list of remote peers (excluding local client).
 * Re-renders whenever any peer joins, leaves, or updates their state.
 *
 * Pass `null` when collab is not active — the hook returns [] safely.
 */
export function useAwareness(awareness: Awareness | null): PeerState[] {
  const [peers, setPeers] = useState<PeerState[]>([])

  useEffect(() => {
    if (!awareness) {
      setPeers([])
      return
    }

    // Capture non-null reference for use inside the closure
    const aw = awareness

    function update() {
      const next: PeerState[] = []
      aw.getStates().forEach((state, clientId) => {
        if (clientId !== aw.clientID) {
          next.push({
            clientId,
            user:   state.user   as CollabUser   | undefined,
            cursor: state.cursor as CollabCursor | undefined,
          })
        }
      })
      setPeers(next)
    }

    aw.on('change', update)
    update() // seed with current state

    return () => {
      aw.off('change', update)
    }
  }, [awareness])

  return peers
}
