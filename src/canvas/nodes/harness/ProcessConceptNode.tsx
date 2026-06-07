import type { NodeProps } from '@xyflow/react'
import { BaseNode } from '../BaseNode'
import type { NodeData } from '../../../store'

type ConceptStatus = 'pending' | 'seeding' | 'active' | 'complete' | 'error'
type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH'

interface LiveProcessConceptState {
  concept_name?: string
  total_steps?: number
  completed_steps?: number
  active_step_id?: string
  active_step_description?: string
  active_step_risk?: RiskLevel
  seeded?: boolean
  status?: ConceptStatus
}

const RISK_COLORS: Record<RiskLevel, string> = {
  LOW: '#4ade80', MEDIUM: '#fbbf24', HIGH: '#f87171',
}

const STATUS_COLORS: Record<ConceptStatus, string> = {
  pending:  '#94a3b8',
  seeding:  '#60a5fa',
  active:   '#22d3ee',
  complete: '#4ade80',
  error:    '#f87171',
}

export function ProcessConceptNode({ id, selected, data }: NodeProps & { data: NodeData }) {
  const cfg  = (data.harness_config as Record<string, unknown>) ?? {}
  const live = (data.live as LiveProcessConceptState) ?? {}

  const conceptId   = (cfg.concept_id as string) ?? ''
  const showSteps   = (cfg.show_steps as boolean) ?? true

  const seeded         = live.seeded ?? false
  const status         = live.status ?? 'pending'
  const totalSteps     = live.total_steps ?? 0
  const completedSteps = live.completed_steps ?? 0
  const progress       = totalSteps > 0 ? completedSteps / totalSteps : 0
  const statusColor    = STATUS_COLORS[status]

  return (
    <BaseNode id={id} type="process_concept" selected={selected} data={data}>
      <div style={{ marginTop: 3 }}>

        {/* concept_id chip + status badge */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{
            fontSize: 11, fontWeight: 700, fontFamily: 'monospace',
            color: '#22d3ee',
            background: 'rgba(34,211,238,0.1)',
            border: '0.5px solid rgba(34,211,238,0.3)',
            padding: '2px 7px', borderRadius: 4,
          }}>
            {conceptId || '—'}
          </span>
          <span style={{
            fontSize: 10, fontWeight: 600, letterSpacing: '0.06em',
            color: statusColor,
            background: `${statusColor}15`,
            border: `0.5px solid ${statusColor}50`,
            padding: '1px 6px', borderRadius: 3,
          }}>
            {status.toUpperCase()}
          </span>
        </div>

        {/* human-readable concept name from live state */}
        {live.concept_name && (
          <div style={{ fontSize: 11, color: '#cbd5e1', marginTop: 4 }}>
            {live.concept_name}
          </div>
        )}

        {/* step progress bar — shown once seeded */}
        {showSteps && seeded && totalSteps > 0 && (
          <div style={{ marginTop: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
              <span style={{
                fontSize: 9, color: '#64748b',
                textTransform: 'uppercase', letterSpacing: '0.08em',
              }}>
                Steps
              </span>
              <span style={{ fontSize: 9, fontFamily: 'monospace', color: '#94a3b8' }}>
                {completedSteps}/{totalSteps}
              </span>
            </div>
            <div style={{
              height: 4, background: 'rgba(255,255,255,0.07)',
              borderRadius: 2, overflow: 'hidden',
            }}>
              <div style={{
                width: `${progress * 100}%`, height: '100%',
                background: progress >= 1 ? '#4ade80' : '#22d3ee',
                borderRadius: 2, transition: 'width 0.3s ease',
              }} />
            </div>
          </div>
        )}

        {/* active step detail */}
        {showSteps && live.active_step_description && (
          <div style={{
            marginTop: 6, padding: '4px 7px', borderRadius: 4,
            background: 'rgba(34,211,238,0.05)',
            border: '0.5px solid rgba(34,211,238,0.2)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2 }}>
              {live.active_step_id && (
                <span style={{
                  fontSize: 9, fontFamily: 'monospace', color: '#475569',
                }}>
                  {live.active_step_id}
                </span>
              )}
              {live.active_step_risk && (
                <span style={{
                  fontSize: 9, fontWeight: 700, letterSpacing: '0.06em',
                  color: RISK_COLORS[live.active_step_risk],
                }}>
                  {live.active_step_risk}
                </span>
              )}
            </div>
            <div style={{ fontSize: 10, color: '#94a3b8', lineHeight: 1.4 }}>
              {live.active_step_description}
            </div>
          </div>
        )}

      </div>
    </BaseNode>
  )
}
