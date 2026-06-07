import type { NodeProps } from '@xyflow/react'
import { BaseNode } from '../BaseNode'
import type { NodeData } from '../../../store'

const DIVERSITY_THRESHOLD = 0.7

interface LiveHypothesis {
  id: string
  explanation: string
  confidence: number
  generation_sources: string[]
  eliminated?: boolean
  elimination_reason?: string
}

interface LiveHypothesisSet {
  active_count?: number
  eliminated_count?: number
  diversity_score?: number
  hypotheses?: LiveHypothesis[]
}

const SOURCE_COLORS: Record<string, string> = {
  symptom_inference: '#60a5fa',
  counterfactual_reasoning: '#c084fc',
  failure_mode_library: '#fb923c',
  analogy_based: '#34d399',
}

export function HypothesisSetNode({ id, selected, data }: NodeProps & { data: NodeData }) {
  const cfg = (data.harness_config as Record<string, unknown>) ?? {}
  const live = (data.live as LiveHypothesisSet) ?? {}
  const showEliminated = (cfg.show_eliminated as boolean) ?? false
  const maxShown = (cfg.max_hypotheses_shown as number) ?? 5

  const activeCount = live.active_count ?? 0
  const eliminatedCount = live.eliminated_count ?? 0
  const diversityScore = live.diversity_score ?? 0
  const belowThreshold = diversityScore < DIVERSITY_THRESHOLD && diversityScore > 0
  const diversityColor = belowThreshold ? '#f87171' : '#4ade80'

  const hypotheses = (live.hypotheses ?? [])
    .filter((h) => !h.eliminated)
    .slice(0, maxShown)
  const eliminated = showEliminated
    ? (live.hypotheses ?? []).filter((h) => h.eliminated)
    : []

  return (
    <BaseNode id={id} type="hypothesis_set" selected={selected} data={data}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
        <span style={{
          fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 4,
          background: 'rgba(192,132,252,0.1)', border: '0.5px solid rgba(192,132,252,0.3)',
          color: '#c084fc', fontFamily: 'monospace',
        }}>
          {activeCount} active
        </span>
        <span style={{
          fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 4,
          background: 'rgba(148,163,184,0.08)', border: '0.5px solid rgba(148,163,184,0.2)',
          color: '#64748b', fontFamily: 'monospace',
        }}>
          {eliminatedCount} eliminated
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 5 }}>
        <span style={{ fontSize: 10, color: '#94a3b8' }}>diversity</span>
        <div
          style={{
            flex: 1, height: 5, background: 'rgba(255,255,255,0.07)',
            borderRadius: 3, overflow: 'hidden', maxWidth: 80,
          }}
          title={belowThreshold
            ? 'Below diversity threshold — additional generation pass required.'
            : `diversity_score=${diversityScore.toFixed(2)}`}
        >
          <div style={{
            width: `${diversityScore * 100}%`, height: '100%',
            background: diversityColor, borderRadius: 3,
          }} />
        </div>
        <span style={{ fontSize: 10, color: diversityColor, fontFamily: 'monospace' }}>
          {diversityScore.toFixed(2)}
        </span>
        {belowThreshold && (
          <span style={{ fontSize: 9, color: '#f87171' }}>▲ low</span>
        )}
      </div>

      {hypotheses.length > 0 && (
        <div style={{ marginTop: 6, borderTop: '0.5px solid rgba(255,255,255,0.07)', paddingTop: 5 }}>
          {hypotheses.map((h) => (
            <div key={h.id} style={{ marginBottom: 5 }}>
              <div style={{ fontSize: 11, color: '#e2e8f0', marginBottom: 2 }}>
                {h.explanation.length > 80 ? h.explanation.slice(0, 80) + '…' : h.explanation}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
                <div style={{
                  width: 50, height: 3, background: 'rgba(255,255,255,0.07)',
                  borderRadius: 2, overflow: 'hidden',
                }}>
                  <div style={{
                    width: `${h.confidence * 100}%`, height: '100%',
                    background: '#c084fc', borderRadius: 2,
                  }} />
                </div>
                {(h.generation_sources ?? []).map((src) => (
                  <span key={src} style={{
                    fontSize: 9, padding: '0 3px', borderRadius: 2,
                    background: `${SOURCE_COLORS[src] ?? '#94a3b8'}20`,
                    border: `0.5px solid ${SOURCE_COLORS[src] ?? '#94a3b8'}50`,
                    color: SOURCE_COLORS[src] ?? '#94a3b8',
                    fontFamily: 'monospace',
                  }}>
                    {src.replace(/_/g, ' ')}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {eliminated.length > 0 && (
        <div style={{ marginTop: 6, borderTop: '0.5px solid rgba(255,255,255,0.07)', paddingTop: 5, opacity: 0.5 }}>
          <div style={{ fontSize: 9, color: '#64748b', marginBottom: 3, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            eliminated
          </div>
          {eliminated.map((h) => (
            <div key={h.id} style={{ fontSize: 10, color: '#64748b', marginBottom: 2 }}>
              {h.explanation.slice(0, 60)}…
              {h.elimination_reason && (
                <span style={{ color: '#475569', marginLeft: 4 }}>({h.elimination_reason})</span>
              )}
            </div>
          ))}
        </div>
      )}
    </BaseNode>
  )
}
