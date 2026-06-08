import type { NodeProps } from '@xyflow/react'
import { BaseNode } from '../BaseNode'
import type { NodeData } from '../../../store'

interface HeatmapCell {
  strategy: string
  failure_class: string
  weight: number
}

interface LiveExperienceStore {
  available?: boolean
  warm_start_status?: 'LOADED' | 'SKIPPED'
  run_count?: number
  strategy_weights?: HeatmapCell[]
}

const STRATEGIES = ['DIRECT_EDIT', 'TRACE_EXEC', 'BROADER_SEARCH', 'REIMPLEMENT', 'MINIMAL_FIX', 'ESCALATE']

function weightColor(w: number): string {
  if (w <= 0) return 'transparent'
  const g = Math.round(74 + (222 - 74) * w)
  const alpha = 0.08 + 0.5 * w
  return `rgba(74,${g},128,${alpha})`
}

export function ExperienceStoreNode({ id, selected, data }: NodeProps & { data: NodeData }) {
  const cfg = (data.harness_config as Record<string, unknown>) ?? {}
  const live = (data.live as LiveExperienceStore) ?? {}

  const showHeatmap = (cfg.show_weights_heatmap as boolean) ?? true
  const showRunCount = (cfg.show_run_count as boolean) ?? true

  const available = live.available ?? false
  const warmStartStatus = live.warm_start_status
  const runCount = live.run_count ?? 0
  const weights = live.strategy_weights ?? []

  if (!available) {
    return (
      <BaseNode id={id} type="experience_store_node" selected={selected} data={data}>
        <div style={{
          marginTop: 6, padding: '8px 10px', borderRadius: 5,
          background: 'rgba(148,163,184,0.06)', border: '0.5px solid rgba(148,163,184,0.15)',
          textAlign: 'center',
        }}>
          <div style={{
            fontSize: 11, fontWeight: 700, color: '#64748b',
            background: 'rgba(100,116,139,0.1)', border: '0.5px solid rgba(100,116,139,0.2)',
            display: 'inline-block', padding: '1px 7px', borderRadius: 4, marginBottom: 4,
            fontFamily: 'monospace',
          }}>
            UNAVAILABLE
          </div>
          <div style={{ fontSize: 10, color: '#475569', lineHeight: 1.5 }}>
            Experience store not connected — warm_start is a no-op. Agent runs correctly without it.
          </div>
        </div>
      </BaseNode>
    )
  }

  const failureClasses = [...new Set(weights.map((c) => c.failure_class))]

  return (
    <BaseNode id={id} type="experience_store_node" selected={selected} data={data}>
      <div style={{ marginTop: 3 }}>
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 4 }}>
          {warmStartStatus && (
            <span style={{
              fontSize: 10, fontFamily: 'monospace', padding: '1px 6px', borderRadius: 4,
              background: warmStartStatus === 'LOADED'
                ? 'rgba(74,222,128,0.08)' : 'rgba(148,163,184,0.08)',
              border: warmStartStatus === 'LOADED'
                ? '0.5px solid rgba(74,222,128,0.25)' : '0.5px solid rgba(148,163,184,0.2)',
              color: warmStartStatus === 'LOADED' ? '#4ade80' : '#94a3b8',
            }}>
              {warmStartStatus}
            </span>
          )}
          {showRunCount && (
            <span style={{
              fontSize: 10, fontFamily: 'monospace', padding: '1px 6px', borderRadius: 4,
              background: 'rgba(167,139,250,0.08)', border: '0.5px solid rgba(167,139,250,0.25)',
              color: '#a78bfa',
            }}>
              {runCount} run{runCount !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        {showHeatmap && failureClasses.length > 0 && (
          <div style={{ marginTop: 5, borderTop: '0.5px solid rgba(255,255,255,0.07)', paddingTop: 4 }}>
            <div style={{ fontSize: 9, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>
              strategy weights
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', fontSize: 8, fontFamily: 'monospace' }}>
                <thead>
                  <tr>
                    <td style={{ width: 70 }} />
                    {failureClasses.map((fc) => (
                      <td key={fc} style={{ color: '#64748b', padding: '0 3px', textAlign: 'center', maxWidth: 30 }}>
                        {fc.length > 6 ? fc.slice(0, 6) + '…' : fc}
                      </td>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {STRATEGIES.map((strategy) => (
                    <tr key={strategy}>
                      <td style={{ color: '#94a3b8', paddingRight: 4, textAlign: 'right' }}>
                        {strategy.length > 9 ? strategy.slice(0, 9) + '…' : strategy}
                      </td>
                      {failureClasses.map((fc) => {
                        const cell = weights.find((c) => c.strategy === strategy && c.failure_class === fc)
                        const w = cell?.weight ?? 0
                        return (
                          <td
                            key={fc}
                            title={`${strategy} × ${fc}: ${w > 0 ? w.toFixed(3) : '—'}`}
                            style={{
                              width: 22, height: 16, textAlign: 'center',
                              background: weightColor(w),
                              color: w > 0.5 ? '#e2e8f0' : '#64748b',
                              border: '0.5px solid rgba(255,255,255,0.04)',
                            }}
                          >
                            {w > 0 ? w.toFixed(2).slice(1) : '—'}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </BaseNode>
  )
}
