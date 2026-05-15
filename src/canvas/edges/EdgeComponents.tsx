import {
  BaseEdge, EdgeLabelRenderer, getStraightPath, type EdgeProps,
} from '@xyflow/react'

// ─── DirectEdge ─────────────────────────────────────────────────────────────

export function DirectEdge({
  id, sourceX, sourceY, targetX, targetY,
  markerEnd, style, data,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getStraightPath({ sourceX, sourceY, targetX, targetY })

  const label       = (data?.label as string | undefined)
  const contextFrom = (data?.context_from as string[] | undefined) ?? []

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={{ stroke: 'var(--border-mid)', strokeWidth: 1.5, ...style }} />

      {(label || contextFrom.length > 0) && (
        <EdgeLabelRenderer>
          <div
            style={{
              position:  'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              pointerEvents: 'all',
            }}
            className="nodrag nopan"
          >
            {label && (
              <span style={{
                background: 'var(--bg-raised)',
                border: '0.5px solid var(--border)',
                borderRadius: 4,
                padding: '1px 6px',
                fontSize: 10,
                color: 'var(--text-secondary)',
                fontFamily: 'var(--font-mono)',
                display: 'block',
                marginBottom: contextFrom.length ? 2 : 0,
              }}>
                {label}
              </span>
            )}
            {contextFrom.length > 0 && (
              <span style={{
                background: 'rgba(139,92,246,0.12)',
                border: '0.5px solid rgba(139,92,246,0.3)',
                borderRadius: 4,
                padding: '1px 6px',
                fontSize: 10,
                color: '#a78bfa',
                fontFamily: 'var(--font-mono)',
                display: 'block',
              }}>
                ctx: {contextFrom.join(', ')}
              </span>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

// ─── ConditionalEdge ────────────────────────────────────────────────────────

export function ConditionalEdge({
  id, sourceX, sourceY, targetX, targetY,
  markerEnd, style, data,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getStraightPath({ sourceX, sourceY, targetX, targetY })

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke: 'var(--c-cond)',
          strokeWidth: 1.5,
          strokeDasharray: '4 3',
          ...style,
        }}
      />
      <EdgeLabelRenderer>
        <div
          style={{
            position:  'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            background: 'var(--bg-raised)',
            border: '0.5px solid rgba(245,158,11,0.3)',
            borderRadius: 4,
            padding: '1px 6px',
            fontSize: 10,
            color: 'var(--c-cond)',
            fontFamily: 'var(--font-mono)',
            pointerEvents: 'all',
          }}
          className="nodrag nopan"
        >
          conditional
        </div>
      </EdgeLabelRenderer>
    </>
  )
}
