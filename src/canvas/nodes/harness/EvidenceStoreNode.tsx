import type { NodeProps } from '@xyflow/react'
import { BaseNode } from '../BaseNode'
import type { NodeData } from '../../../store'

interface ToolEnvelope {
  tool: string
  max_conclusion_reliability: 'HIGH' | 'MEDIUM' | 'LOW'
  available: boolean
  fallback_tool?: string
}

interface LiveEvidenceStore {
  high_count?: number
  medium_count?: number
  low_count?: number
  total_count?: number
  tool_envelopes?: ToolEnvelope[]
}

const REL_COLORS = { HIGH: '#4ade80', MEDIUM: '#fbbf24', LOW: '#94a3b8' }

export function EvidenceStoreNode({ id, selected, data }: NodeProps & { data: NodeData }) {
  const cfg = (data.harness_config as Record<string, unknown>) ?? {}
  const live = (data.live as LiveEvidenceStore) ?? {}

  const showEnvelopes = (cfg.show_envelopes as boolean) ?? true
  const showManifest = (cfg.show_manifest as boolean) ?? true

  const highCount = live.high_count ?? 0
  const medCount = live.medium_count ?? 0
  const lowCount = live.low_count ?? 0
  const total = live.total_count ?? highCount + medCount + lowCount
  const envelopes = live.tool_envelopes ?? []

  const barTotal = Math.max(highCount + medCount + lowCount, 1)

  return (
    <BaseNode id={id} type="evidence_store_node" selected={selected} data={data}>
      <div style={{ marginTop: 3 }}>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 4 }}>
          <span style={{
            fontSize: 10, fontFamily: 'monospace', color: '#4ade80',
            background: 'rgba(74,222,128,0.08)', border: '0.5px solid rgba(74,222,128,0.25)',
            padding: '1px 5px', borderRadius: 3,
          }}>
            {highCount} H
          </span>
          <span style={{
            fontSize: 10, fontFamily: 'monospace', color: '#fbbf24',
            background: 'rgba(251,191,36,0.08)', border: '0.5px solid rgba(251,191,36,0.25)',
            padding: '1px 5px', borderRadius: 3,
          }}>
            {medCount} M
          </span>
          <span style={{
            fontSize: 10, fontFamily: 'monospace', color: '#94a3b8',
            background: 'rgba(148,163,184,0.08)', border: '0.5px solid rgba(148,163,184,0.2)',
            padding: '1px 5px', borderRadius: 3,
          }}>
            {lowCount} L
          </span>
          <span style={{ fontSize: 10, color: '#64748b' }}>({total} total)</span>
        </div>

        <div style={{ display: 'flex', height: 5, borderRadius: 3, overflow: 'hidden', marginBottom: 6 }}>
          <div style={{ width: `${highCount / barTotal * 100}%`, background: '#4ade80' }} />
          <div style={{ width: `${medCount / barTotal * 100}%`, background: '#fbbf24' }} />
          <div style={{ width: `${lowCount / barTotal * 100}%`, background: '#94a3b8' }} />
        </div>

        {showEnvelopes && envelopes.length > 0 && (
          <div style={{ marginTop: 5, borderTop: '0.5px solid rgba(255,255,255,0.07)', paddingTop: 4 }}>
            <div style={{ fontSize: 9, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 3 }}>
              tool envelopes
            </div>
            {envelopes.map((env) => (
              <div key={env.tool} style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
                <span style={{ fontSize: 10, fontFamily: 'monospace', color: '#94a3b8', flex: 1 }}>
                  {env.tool}
                </span>
                <span style={{
                  fontSize: 9, fontFamily: 'monospace', padding: '0 4px', borderRadius: 3,
                  color: REL_COLORS[env.max_conclusion_reliability],
                  background: `${REL_COLORS[env.max_conclusion_reliability]}12`,
                }}>
                  cap:{env.max_conclusion_reliability}
                </span>
              </div>
            ))}
          </div>
        )}

        {showManifest && envelopes.length > 0 && (
          <div style={{ marginTop: 5, borderTop: '0.5px solid rgba(255,255,255,0.07)', paddingTop: 4 }}>
            <div style={{ fontSize: 9, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 3 }}>
              availability
            </div>
            {envelopes.map((env) => (
              <div key={env.tool} style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
                <div style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: env.available ? '#4ade80' : '#f87171',
                  flexShrink: 0,
                }} />
                <span style={{ fontSize: 10, fontFamily: 'monospace', color: '#94a3b8', flex: 1 }}>
                  {env.tool}
                </span>
                {!env.available && env.fallback_tool && (
                  <span style={{ fontSize: 9, color: '#64748b' }}>→ {env.fallback_tool}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </BaseNode>
  )
}
