/**
 * collab/CollabCursors.tsx
 *
 * Renders floating cursors for all remote collaborators on the canvas.
 * Must be placed inside <ReactFlowProvider> so useReactFlow() is available.
 * Reads awareness from the Zustand store — no props required.
 */
import { useReactFlow } from '@xyflow/react'
import { useCanvasStore } from '../store'
import { useAwareness } from './useAwareness'

export function CollabCursors() {
  const awareness = useCanvasStore((s) => s._collabAwareness)
  const peers = useAwareness(awareness)
  const { flowToScreenPosition } = useReactFlow()

  if (!awareness || peers.length === 0) return null

  return (
    <div
      style={{
        position:      'absolute',
        inset:         0,
        pointerEvents: 'none',
        overflow:      'hidden',
        zIndex:        20,
      }}
    >
      {peers.map((peer) => {
        if (!peer.cursor) return null
        const screen = flowToScreenPosition(peer.cursor)
        return (
          <div
            key={peer.clientId}
            style={{
              position:  'absolute',
              left:      screen.x,
              top:       screen.y,
              transform: 'translate(-2px, -2px)',
              pointerEvents: 'none',
            }}
          >
            {/* Cursor SVG */}
            <svg width="16" height="20" viewBox="0 0 16 20" fill="none">
              <path
                d="M0 0L0 16L4.5 12L7.5 19L9.5 18L6.5 11L12 11Z"
                fill={peer.color ?? '#6366f1'}
              />
            </svg>
            {/* Name label */}
            <div style={{
              marginTop:    2,
              marginLeft:   6,
              padding:      '1px 5px',
              borderRadius: 3,
              background:   peer.color ?? '#6366f1',
              color:        '#fff',
              fontSize:     11,
              whiteSpace:   'nowrap',
              maxWidth:     120,
              overflow:     'hidden',
              textOverflow: 'ellipsis',
            }}>
              {peer.name ?? 'Anonymous'}
            </div>
          </div>
        )
      })}
    </div>
  )
}
