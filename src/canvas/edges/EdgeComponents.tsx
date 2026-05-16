import { useState } from 'react'
import {
  BaseEdge, EdgeLabelRenderer, getStraightPath, getSmoothStepPath, getBezierPath,
  type EdgeProps,
} from '@xyflow/react'
import { useCanvasStore } from '../../store'
import { NODE_ICONS, NODE_HEX, NODE_TYPE_LABELS } from '../nodes/BaseNode'
import type { NodeType } from '../../spec/schema'

// Single selection blue — used for nodes, edges, and the focus ring.
// Previously a mix of #3b82f6 and #6366f1; unified here.
const SELECTED_BLUE = '#3b82f6'

// ─── Edge midpoint insert button ─────────────────────────────────────────────

const QUICK_INSERT: NodeType[] = [
  'llm_call', 'tool_invoke', 'condition', 'transform', 'memory_read',
]

function InsertButton({ edgeId, cx, cy }: { edgeId: string; cx: number; cy: number }) {
  const [open, setOpen]  = useState(false)
  const insertNodeOnEdge = useCanvasStore((s) => s.insertNodeOnEdge)

  return (
    <EdgeLabelRenderer>
      <div
        style={{
          position: 'absolute',
          transform: `translate(-50%, -50%) translate(${cx}px, ${cy}px)`,
          pointerEvents: 'all',
          zIndex: 10,
        }}
        className="nodrag nopan"
      >
        {/* Invisible 28×28 hit-ring around the visible 18×18 button so the
            target stays usable at zoom 0.5. Hover state targets the ring. */}
        <button
          onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          className="edge-insert-btn"
          title="Insert node here"
          aria-label="Insert node on this edge"
        >
          <span className="edge-insert-btn__inner">+</span>
        </button>

        {open && (
          <div className="edge-insert-menu">
            {QUICK_INSERT.map((type) => {
              const Icon  = NODE_ICONS[type]
              const color = NODE_HEX[type]
              return (
                <button
                  key={type}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    setOpen(false)
                    insertNodeOnEdge(edgeId, type)
                  }}
                  className="edge-insert-menu__item"
                >
                  <Icon size={12} style={{ color, flexShrink: 0 }} strokeWidth={1.75} />
                  {NODE_TYPE_LABELS[type]}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </EdgeLabelRenderer>
  )
}

// ─── DirectEdge ─────────────────────────────────────────────────────────────

export function DirectEdge({
  id, sourceX, sourceY, targetX, targetY,
  markerEnd, style, data, selected,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getStraightPath({ sourceX, sourceY, targetX, targetY })
  const [hovered, setHovered]      = useState(false)

  const label       = (data?.label as string | undefined)
  const contextFrom = (data?.context_from as string[] | undefined) ?? []
  const showInsert  = hovered || selected

  // Anchor label and context_from pill at different points along the path so
  // they don't pile on the midpoint when both are present.
  const labelAnchorX = sourceX + (targetX - sourceX) * 0.35
  const labelAnchorY = sourceY + (targetY - sourceY) * 0.35
  const ctxAnchorX   = sourceX + (targetX - sourceX) * 0.7
  const ctxAnchorY   = sourceY + (targetY - sourceY) * 0.7

  return (
    <>
      {/* Invisible wide hit-target for hover */}
      <path
        d={edgePath}
        stroke="transparent"
        strokeWidth={18}
        fill="none"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke: selected ? SELECTED_BLUE : 'var(--border-mid)',
          strokeWidth: selected ? 2 : 1.5,
          transition: 'stroke 0.1s, stroke-width 0.1s',
          ...style,
        }}
      />

      {label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelAnchorX}px,${labelAnchorY}px)`,
              pointerEvents: 'all',
            }}
            className="nodrag nopan edge-label"
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}

      {contextFrom.length > 0 && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${ctxAnchorX}px,${ctxAnchorY}px)`,
              pointerEvents: 'all',
            }}
            className="nodrag nopan edge-ctx-pill"
            title={`context_from: ${contextFrom.join(', ')}`}
          >
            ctx · {contextFrom.length === 1 ? contextFrom[0] : `${contextFrom.length}`}
          </div>
        </EdgeLabelRenderer>
      )}

      {showInsert && (
        <InsertButton edgeId={id} cx={labelX} cy={labelY} />
      )}
    </>
  )
}

// ─── ConditionalEdge ─────────────────────────────────────────────────────────
// Uses orthogonal step routing (was bezier with curvature 0.3) so that fan-out
// from a single condition node doesn't pile on top of itself. Labels are
// anchored on the SOURCE-side leg so siblings don't share a midpoint.

export function ConditionalEdge({
  id, sourceX, sourceY, targetX, targetY,
  markerEnd, style, data, selected,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX, sourceY, targetX, targetY,
    borderRadius: 8,
  })
  const label = (data?.label as string | undefined) ?? 'condition'

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke: selected ? '#d97706' : 'var(--c-cond)',
          strokeWidth: selected ? 2 : 1.5,
          strokeDasharray: '5 3',
          ...style,
        }}
      />
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            background: 'var(--bg-raised)',
            border: '0.5px solid rgba(217,119,6,0.4)',
            borderRadius: 4, padding: '1px 7px',
            fontSize: 10, color: 'var(--c-cond)',
            fontFamily: 'var(--font-mono)',
            pointerEvents: 'all',
          }}
          className="nodrag nopan"
        >
          {label}
        </div>
      </EdgeLabelRenderer>
    </>
  )
}

// ─── ParallelEdge — same orthogonal treatment for fork fan-out ──────────────

export function ParallelEdge({
  id, sourceX, sourceY, targetX, targetY,
  markerEnd, style, selected,
}: EdgeProps) {
  const [edgePath] = getSmoothStepPath({
    sourceX, sourceY, targetX, targetY,
    borderRadius: 8,
  })

  return (
    <>
      {/* Base track — thin, low-opacity so the animated overlay reads clearly */}
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke: selected ? '#16a34a' : 'var(--c-fork)',
          strokeWidth: selected ? 2 : 1.5,
          strokeDasharray: '6 3',
          opacity: 0.5,
          ...style,
        }}
      />
      {/* Animated overlay — CSS stroke-dashoffset scroll for a "flowing" dot effect.
          Uses a separate path element so the animation is self-contained and works
          in any rendering context (no animateMotion SVG root dependency).
          markerEnd intentionally omitted — BaseEdge above already carries the arrowhead. */}
      <path
        d={edgePath}
        fill="none"
        stroke="var(--c-fork)"
        strokeWidth={selected ? 2.5 : 2}
        strokeDasharray="4 14"
        strokeLinecap="round"
        style={{
          animation: 'parallelFlow 1.2s linear infinite',
          opacity: selected ? 1 : 0.85,
        }}
      />
    </>
  )
}

// ─── HitlEdge ────────────────────────────────────────────────────────────────

export function HitlEdge({
  id, sourceX, sourceY, targetX, targetY,
  markerEnd, style, selected,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getStraightPath({ sourceX, sourceY, targetX, targetY })

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke: selected ? '#ea6c0a' : 'var(--c-hitl)',
          strokeWidth: selected ? 2 : 1.5,
          strokeDasharray: '3 3',
          ...style,
        }}
      />
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            background: 'rgba(249,115,22,0.1)',
            border: '0.5px solid rgba(249,115,22,0.35)',
            borderRadius: 4, padding: '1px 7px',
            fontSize: 9, color: 'var(--c-hitl)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          pause
        </div>
      </EdgeLabelRenderer>
    </>
  )
}

// ─── FailEdge ────────────────────────────────────────────────────────────────

export function FailEdge({
  id, sourceX, sourceY, targetX, targetY,
  markerEnd, style, selected,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getStraightPath({ sourceX, sourceY, targetX, targetY })

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke: selected ? '#dc2626' : 'var(--c-fail)',
          strokeWidth: selected ? 2 : 1.5,
          strokeDasharray: '4 3',
          opacity: selected ? 1 : 0.75,
          ...style,
        }}
      />
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            background: 'rgba(239,68,68,0.1)',
            border: '0.5px solid rgba(239,68,68,0.4)',
            borderRadius: 4, padding: '1px 7px',
            fontSize: 9, color: '#f87171',
            fontFamily: 'var(--font-mono)',
          }}
        >
          on fail
        </div>
      </EdgeLabelRenderer>
    </>
  )
}

// Retained for compat — exported in case anything else imports it.
export { getBezierPath }
