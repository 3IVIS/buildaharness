/**
 * FlowDiffModal
 *
 * Compares the current canvas spec against a library snapshot.
 * Shows added / removed / changed nodes and edges.
 *
 * No backend required — works purely from localStorage snapshots.
 * DB-backed versioning (Phase 2) will replace this with server-side diffs.
 */

import { useState, useMemo } from 'react'
import { X, Plus, Minus, RefreshCw, ArrowRight } from 'lucide-react'
import { useCanvasStore } from '../store'
import { useLibraryStore } from '../store/library'
import type { FlowSpec } from '../spec/schema'
import { NODE_ICONS, NODE_HEX, NODE_TYPE_LABELS } from '../canvas/nodes/BaseNode'
import type { NodeType } from '../spec/schema'

// ─── Diff engine ─────────────────────────────────────────────────────────────

interface NodeEntry {
  id:       string
  type:     string
  label:    string
  position: { x: number; y: number }
  data:     Record<string, unknown>
}

interface EdgeEntry {
  id:   string
  from: string
  to:   string
  type: string
}

interface NodeDiff {
  kind:    'added' | 'removed' | 'changed'
  id:      string
  type:    string
  label:   string
  changes: string[]  // field names that changed
}

interface EdgeDiff {
  kind: 'added' | 'removed'
  id:   string
  from: string
  to:   string
}

interface DiffResult {
  nodes:     NodeDiff[]
  edges:     EdgeDiff[]
  unchanged: number  // node count
}

function specToNodes(spec: FlowSpec): Map<string, NodeEntry> {
  const map = new Map<string, NodeEntry>()
  for (const n of spec.nodes) {
    const raw = n as Record<string, unknown>
    map.set(n.id, {
      id:       n.id,
      type:     n.type as string,
      label:    (raw.label as string) || (n.type as string),
      position: (raw.position as { x: number; y: number }) ?? { x: 0, y: 0 },
      data:     raw,
    })
  }
  return map
}

function specToEdges(spec: FlowSpec): Map<string, EdgeEntry> {
  const map = new Map<string, EdgeEntry>()
  for (const e of spec.edges) {
    const raw  = e as Record<string, unknown>
    const from = raw.from as string ?? ''
    // DirectEdge has .to; ConditionalEdge has .branches[].to — use first branch
    const to   = (raw.to as string | undefined)
               ?? ((raw.branches as Array<{ to: string }> | undefined)?.[0]?.to ?? '')
    const id   = raw.id as string ?? `${from}→${to}`
    map.set(id, { id, from, to, type: e.type })
  }
  return map
}

function diffSpecs(base: FlowSpec, head: FlowSpec): DiffResult {
  const baseNodes = specToNodes(base)
  const headNodes = specToNodes(head)
  const baseEdges = specToEdges(base)
  const headEdges = specToEdges(head)

  const nodes: NodeDiff[] = []
  let unchanged = 0

  // Removed nodes (in base but not head)
  for (const [id, node] of baseNodes) {
    if (!headNodes.has(id)) {
      nodes.push({ kind: 'removed', id, type: node.type, label: node.label, changes: [] })
    }
  }

  // Added or changed nodes
  for (const [id, node] of headNodes) {
    if (!baseNodes.has(id)) {
      nodes.push({ kind: 'added', id, type: node.type, label: node.label, changes: [] })
    } else {
      const prev = baseNodes.get(id)!
      const changes: string[] = []
      // Compare data fields (excluding position — layout changes are noise)
      const allKeys = new Set([...Object.keys(prev.data), ...Object.keys(node.data)])
      for (const key of allKeys) {
        if (key === 'position') continue
        if (JSON.stringify(prev.data[key]) !== JSON.stringify(node.data[key])) {
          changes.push(key)
        }
      }
      if (changes.length > 0) {
        nodes.push({ kind: 'changed', id, type: node.type, label: node.label, changes })
      } else {
        unchanged++
      }
    }
  }

  const edges: EdgeDiff[] = []

  // Removed edges
  for (const [id, edge] of baseEdges) {
    if (!headEdges.has(id)) {
      edges.push({ kind: 'removed', id, from: edge.from, to: edge.to })
    }
  }

  // Added edges
  for (const [id, edge] of headEdges) {
    if (!baseEdges.has(id)) {
      edges.push({ kind: 'added', id, from: edge.from, to: edge.to })
    }
  }

  return { nodes, edges, unchanged }
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

const KIND_STYLES = {
  added:   { color: '#22c55e', bg: 'rgba(34,197,94,0.08)',   icon: Plus,      label: 'added'   },
  removed: { color: '#ef4444', bg: 'rgba(239,68,68,0.08)',   icon: Minus,     label: 'removed' },
  changed: { color: '#f59e0b', bg: 'rgba(245,158,11,0.08)',  icon: RefreshCw, label: 'changed' },
}

function NodeDiffRow({ diff }: { diff: NodeDiff }) {
  const style  = KIND_STYLES[diff.kind]
  const Icon   = NODE_ICONS[diff.type as NodeType]
  const hex    = NODE_HEX[diff.type as NodeType] ?? '#6b7280'
  const KindIcon = style.icon
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '6px 0', borderBottom: '0.5px solid var(--border)' }}>
      <div style={{ width: 18, height: 18, borderRadius: 4, background: style.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>
        <KindIcon size={10} style={{ color: style.color }} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {Icon && <Icon size={12} style={{ color: hex, flexShrink: 0 }} strokeWidth={1.75} />}
          <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{diff.label}</span>
          <span style={{ fontSize: 9, fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)', flexShrink: 0 }}>{NODE_TYPE_LABELS[diff.type as NodeType] ?? diff.type}</span>
        </div>
        {diff.changes.length > 0 && (
          <div style={{ fontSize: 10, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>
            {diff.changes.slice(0, 5).join(', ')}{diff.changes.length > 5 ? ` +${diff.changes.length - 5} more` : ''}
          </div>
        )}
      </div>
      <span style={{ fontSize: 9, fontFamily: 'var(--font-mono)', color: style.color, flexShrink: 0, opacity: 0.8, marginTop: 2 }}>{diff.id}</span>
    </div>
  )
}

function EdgeDiffRow({ diff }: { diff: EdgeDiff }) {
  const style = KIND_STYLES[diff.kind]
  const KindIcon = style.icon
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 0', borderBottom: '0.5px solid var(--border)' }}>
      <div style={{ width: 18, height: 18, borderRadius: 4, background: style.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <KindIcon size={10} style={{ color: style.color }} />
      </div>
      <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {diff.from} <ArrowRight size={10} style={{ display: 'inline', verticalAlign: 'middle', opacity: 0.5 }} /> {diff.to}
      </span>
    </div>
  )
}

// ─── Modal ───────────────────────────────────────────────────────────────────

interface Props { onClose: () => void }

export function FlowDiffModal({ onClose }: Props) {
  const { exportSpec, flowMeta } = useCanvasStore()
  const { entries, getFlow }     = useLibraryStore()

  const [compareId, setCompareId] = useState<string>(entries[0]?.id ?? '')

  const currentSpec = useMemo(() => exportSpec(), [exportSpec])

  const compareSpec: FlowSpec | null = useMemo(() => {
    if (!compareId) return null
    return getFlow(compareId) ?? null
  }, [compareId, getFlow])

  const diff: DiffResult | null = useMemo(() => {
    if (!currentSpec || !compareSpec) return null
    // base = library snapshot (older), head = current canvas (newer)
    return diffSpecs(compareSpec, currentSpec)
  }, [currentSpec, compareSpec])

  const addedCount   = diff?.nodes.filter((n) => n.kind === 'added').length ?? 0
  const removedCount = diff?.nodes.filter((n) => n.kind === 'removed').length ?? 0
  const changedCount = diff?.nodes.filter((n) => n.kind === 'changed').length ?? 0
  const edgeAddedCount   = diff?.edges.filter((e) => e.kind === 'added').length ?? 0
  const edgeRemovedCount = diff?.edges.filter((e) => e.kind === 'removed').length ?? 0

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" style={{ width: 'min(640px, 100%)' }}>
        {/* Header */}
        <div className="modal__header">
          <span className="modal__title">Compare versions</span>
          <button className="config-panel__close" onClick={onClose}><X size={14} /></button>
        </div>

        {/* Controls */}
        <div style={{ padding: '12px 18px', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 4, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Base (library snapshot)</div>
            <select
              className="field__select"
              value={compareId}
              onChange={(e) => setCompareId(e.target.value)}
            >
              {entries.length === 0
                ? <option value="">No saved versions</option>
                : entries.map((e) => (
                  <option key={e.id} value={e.id}>{e.name || e.id}</option>
                ))}
            </select>
          </div>
          <div style={{ flexShrink: 0, paddingTop: 14 }}>
            <ArrowRight size={14} style={{ color: 'var(--text-tertiary)' }} />
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 4, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Head (current canvas)</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '6px 8px', background: 'var(--bg-overlay)', borderRadius: 'var(--r-md)', border: '0.5px solid var(--border)' }}>
              {flowMeta.name || flowMeta.id}
              {currentSpec === null && <span style={{ color: '#ef4444', marginLeft: 6, fontSize: 10 }}>validation failed</span>}
            </div>
          </div>
        </div>

        {/* Summary */}
        {diff && (
          <div style={{ display: 'flex', padding: '10px 18px', borderBottom: '0.5px solid var(--border)', flexWrap: 'wrap', gap: '6px' }}>
            {[
              { n: addedCount,       label: 'added',       color: '#22c55e' },
              { n: removedCount,     label: 'removed',     color: '#ef4444' },
              { n: changedCount,     label: 'changed',     color: '#f59e0b' },
              { n: diff.unchanged,   label: 'unchanged',   color: 'var(--text-tertiary)' },
              { n: edgeAddedCount,   label: 'edges added', color: '#22c55e' },
              { n: edgeRemovedCount, label: 'edges removed', color: '#ef4444' },
            ].filter(({ n }) => n > 0).map(({ n, label, color }) => (
              <span key={label} style={{ fontSize: 11, background: 'var(--bg-overlay)', borderRadius: 4, padding: '2px 8px', display: 'inline-flex', gap: 4 }}>
                <span style={{ fontWeight: 600, color }}>{n}</span>
                <span style={{ color: 'var(--text-tertiary)' }}>{label}</span>
              </span>
            ))}
            {addedCount === 0 && removedCount === 0 && changedCount === 0 && edgeAddedCount === 0 && edgeRemovedCount === 0 && (
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>No structural changes</span>
            )}
          </div>
        )}

        {/* Diff body */}
        <div className="modal__body" style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {!diff && !currentSpec && (
            <div className="empty-state">
              <div className="empty-state__title">Validation failed</div>
              <div className="empty-state__desc">Fix spec errors before diffing.</div>
            </div>
          )}
          {!diff && currentSpec && entries.length === 0 && (
            <div className="empty-state">
              <div className="empty-state__title">No saved snapshots</div>
              <div className="empty-state__desc">Save the flow to the library first, then make changes and diff.</div>
            </div>
          )}

          {diff && diff.nodes.length > 0 && (
            <>
              <div className="section-head" style={{ marginBottom: 8 }}>Nodes</div>
              {diff.nodes.map((n) => <NodeDiffRow key={n.id} diff={n} />)}
            </>
          )}

          {diff && diff.edges.length > 0 && (
            <>
              <div className="section-head" style={{ marginTop: 16, marginBottom: 8 }}>Edges</div>
              {diff.edges.map((e) => <EdgeDiffRow key={e.id} diff={e} />)}
            </>
          )}

          {diff && diff.nodes.length === 0 && diff.edges.length === 0 && (
            <div className="empty-state" style={{ paddingTop: 32 }}>
              <div className="empty-state__title">Identical structure</div>
              <div className="empty-state__desc">No node or edge changes between these versions.<br/>Position-only moves are excluded from the diff.</div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
