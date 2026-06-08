import type { NodeProps } from '@xyflow/react'
import { BaseNode } from '../BaseNode'
import type { NodeData } from '../../../store'

interface LiveWorldModel {
  generation_id?: number
  belief_count?: number
  observation_count?: number
  contradiction_count?: number
  staleness_ratio?: number
  beliefs?: Array<{ id: string; statement: string; confidence: number; derived_from: string[] }>
}

function StatChip({ label, value }: { label: string; value: string | number }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3,
      padding: '1px 6px', borderRadius: 4, fontSize: 10, fontWeight: 500,
      background: 'rgba(251,113,133,0.08)', border: '0.5px solid rgba(251,113,133,0.25)',
      color: '#fb7185', marginRight: 4, marginBottom: 3,
      fontFamily: 'var(--font-mono, monospace)',
    }}>
      {label}:<span style={{ color: '#e2e8f0', marginLeft: 2 }}>{value}</span>
    </span>
  )
}

function StalenessBar({ ratio }: { ratio: number }) {
  const color = ratio > 0.2 ? '#fbbf24' : '#4ade80'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 3 }}>
      <span style={{ fontSize: 10, color: '#94a3b8' }}>staleness</span>
      <div style={{
        flex: 1, height: 4, background: 'rgba(255,255,255,0.07)',
        borderRadius: 2, overflow: 'hidden', maxWidth: 80,
      }}>
        <div style={{
          width: `${Math.min(ratio * 100, 100)}%`, height: '100%',
          background: color, borderRadius: 2, transition: 'width 0.3s',
        }} />
      </div>
      <span style={{ fontSize: 10, color, fontFamily: 'monospace' }}>
        {(ratio * 100).toFixed(0)}%
      </span>
    </div>
  )
}

export function WorldModelNode({ id, selected, data }: NodeProps & { data: NodeData }) {
  const cfg = (data.harness_config as Record<string, unknown>) ?? {}
  const live = (data.live as LiveWorldModel) ?? {}
  const displayMode = (cfg.display_mode as string) ?? 'summary'
  const maxBeliefs = (cfg.max_beliefs_shown as number) ?? 10

  const genId = live.generation_id ?? '—'
  const beliefCount = live.belief_count ?? 0
  const obsCount = live.observation_count ?? 0
  const contradCount = live.contradiction_count ?? 0
  const stalenessRatio = live.staleness_ratio ?? 0
  const beliefs = (live.beliefs ?? []).slice(0, maxBeliefs)

  return (
    <BaseNode id={id} type="world_model" selected={selected} data={data}>
      <div style={{ display: 'flex', flexWrap: 'wrap', marginTop: 2 }}>
        <StatChip label="gen" value={genId} />
        <StatChip label="beliefs" value={beliefCount} />
        <StatChip label="obs" value={obsCount} />
        {(data.harness_config as Record<string, unknown>)?.show_contradictions !== false && (
          <StatChip label="contradictions" value={contradCount} />
        )}
      </div>
      <StalenessBar ratio={stalenessRatio} />
      {displayMode === 'expanded' && beliefs.length > 0 && (
        <div style={{ marginTop: 6, borderTop: '0.5px solid rgba(255,255,255,0.07)', paddingTop: 5 }}>
          {beliefs.map((b) => (
            <div key={b.id} style={{ marginBottom: 4 }}>
              <div style={{ fontSize: 11, color: '#e2e8f0', marginBottom: 2 }}>
                {b.statement.length > 80 ? b.statement.slice(0, 80) + '…' : b.statement}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <div style={{
                  flex: 1, height: 3, background: 'rgba(255,255,255,0.07)',
                  borderRadius: 2, overflow: 'hidden', maxWidth: 60,
                }}>
                  <div style={{
                    width: `${b.confidence * 100}%`, height: '100%',
                    background: '#4ade80', borderRadius: 2,
                  }} />
                </div>
                <span style={{ fontSize: 10, color: '#94a3b8', fontFamily: 'monospace' }}>
                  {(b.confidence * 100).toFixed(0)}%
                </span>
                {b.derived_from?.map((src) => (
                  <span key={src} style={{
                    fontSize: 9, color: '#64748b', fontFamily: 'monospace',
                    background: 'rgba(255,255,255,0.04)', padding: '0 3px', borderRadius: 2,
                  }}>
                    {src}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </BaseNode>
  )
}
