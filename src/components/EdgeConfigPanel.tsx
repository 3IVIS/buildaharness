import { X } from 'lucide-react'
import { useCanvasStore } from '../store'

export function EdgeConfigPanel() {
  const { edges, nodes, selectedEdgeId, updateEdgeData, closeEdgePanel } = useCanvasStore()

  const edge = edges.find((e) => e.id === selectedEdgeId)
  if (!edge) return null

  const data        = (edge.data ?? {}) as Record<string, unknown>
  const label       = (data.label as string) ?? ''
  const contextFrom = (data.context_from as string[]) ?? []
  const nodeIds     = nodes.map((n) => n.id)

  const sourceNode = nodes.find((n) => n.id === edge.source)
  const targetNode = nodes.find((n) => n.id === edge.target)

  function toggleCtx(nodeId: string) {
    const next = contextFrom.includes(nodeId)
      ? contextFrom.filter((c) => c !== nodeId)
      : [...contextFrom, nodeId]
    updateEdgeData(edge!.id, { context_from: next })
  }

  return (
    <div className="config-panel">
      <div className="config-panel__header">
        <div>
          <div className="config-panel__type">direct edge</div>
          <div className="config-panel__name">
            {String(sourceNode?.data?.label ?? edge.source)}
            <span style={{ color: 'var(--text-tertiary)', margin: '0 4px' }}>→</span>
            {String(targetNode?.data?.label ?? edge.target)}
          </div>
        </div>
        <button className="config-panel__close btn btn--icon" onClick={closeEdgePanel}><X size={14} /></button>
      </div>

      <div className="config-panel__body">
        <div className="field">
          <label className="field__label">Edge label <span className="field__label-hint">shown on canvas</span></label>
          <input className="field__input" value={label}
            onChange={(e) => updateEdgeData(edge!.id, { label: e.target.value })}
            placeholder="e.g. high / low-medium / approved" />
        </div>

        <div className="section-head" style={{ marginTop: 4 }}>context_from</div>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.6, marginBottom: 6 }}>
          Nodes whose output is passed as context to the target (CrewAI Task.context model).
        </div>

        {nodeIds.filter((id) => id !== edge.target).map((nodeId) => {
          const n       = nodes.find((node) => node.id === nodeId)
          const nLabel  = n?.data?.label as string | undefined
          const checked = contextFrom.includes(nodeId)
          return (
            <label key={nodeId} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0',
              cursor: 'pointer', borderBottom: '0.5px solid var(--border)',
            }}>
              <input type="checkbox" checked={checked} onChange={() => toggleCtx(nodeId)} style={{ accentColor: '#8b5cf6' }} />
              <div style={{ flex: 1 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)' }}>{nodeId}</span>
                {nLabel && nLabel !== nodeId && (
                  <span style={{ fontSize: 11, color: 'var(--text-tertiary)', marginLeft: 6 }}>— {nLabel}</span>
                )}
              </div>
              {checked && (
                <span style={{ fontSize: 9, background: 'rgba(139,92,246,0.15)', color: '#a78bfa', padding: '1px 5px', borderRadius: 3, fontFamily: 'var(--font-mono)' }}>ctx</span>
              )}
            </label>
          )
        })}

        {contextFrom.length > 0 && (
          <div style={{ marginTop: 8, padding: '6px 8px', background: 'rgba(139,92,246,0.08)', borderRadius: 6, border: '0.5px solid rgba(139,92,246,0.2)' }}>
            <div style={{ fontSize: 10, color: '#a78bfa', fontFamily: 'var(--font-mono)', marginBottom: 2 }}>context_from</div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>[{contextFrom.join(', ')}]</div>
          </div>
        )}
      </div>
    </div>
  )
}
