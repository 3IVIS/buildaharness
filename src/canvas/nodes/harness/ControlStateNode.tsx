import type { NodeProps } from '@xyflow/react'
import { BaseNode } from '../BaseNode'
import type { NodeData } from '../../../store'

type RiskState = 'NORMAL' | 'CAUTIOUS' | 'BLOCKED'

interface BlockEntry {
  dimension: string
  recovery_action?: string
  mutually_blocked_by?: string
}

interface LiveControlState {
  risk_state?: RiskState
  generation_id?: number
  world_model_generation_id?: number
  escalation_reason?: string
  block_mask?: BlockEntry[]
  notes?: string[]
}

const RISK_COLORS: Record<RiskState, string> = {
  NORMAL: '#4ade80',
  CAUTIOUS: '#fbbf24',
  BLOCKED: '#f87171',
}

export function ControlStateNode({ id, selected, data }: NodeProps & { data: NodeData }) {
  const cfg = (data.harness_config as Record<string, unknown>) ?? {}
  const live = (data.live as LiveControlState) ?? {}

  const riskState: RiskState = (live.risk_state as RiskState) ?? 'NORMAL'
  const genId = live.generation_id
  const wmGenId = live.world_model_generation_id
  const isStale = genId != null && wmGenId != null && genId < wmGenId
  const showBlockMask = (cfg.show_block_mask as boolean) ?? true
  const showNotes = (cfg.show_notes as boolean) ?? false
  const blockMask = live.block_mask ?? []
  const riskColor = RISK_COLORS[riskState]

  const isDeadlock = blockMask.length >= 2 &&
    blockMask.some((b) => b.mutually_blocked_by && blockMask.some((b2) => b2.dimension === b.mutually_blocked_by))

  return (
    <BaseNode id={id} type="control_state" selected={selected} data={data}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
        <span style={{
          fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 5,
          background: `${riskColor}15`,
          border: `1.5px solid ${riskColor}60`,
          color: riskColor, letterSpacing: '0.05em',
        }}>
          {riskState}
        </span>

        {genId != null && (
          <span style={{
            fontSize: 10, fontFamily: 'monospace',
            color: isStale ? '#fbbf24' : '#94a3b8',
            padding: '1px 5px', borderRadius: 3,
            background: isStale ? 'rgba(251,191,36,0.08)' : 'rgba(255,255,255,0.04)',
            border: isStale ? '0.5px solid rgba(251,191,36,0.3)' : '0.5px solid rgba(255,255,255,0.07)',
          }}
            title={isStale
              ? `control_state.generation_id=${genId} is behind world_model.generation_id=${wmGenId} — will re-resolve on next gate.`
              : `generation_id=${genId}`}
          >
            gen:{genId}
            {isStale && <span style={{ marginLeft: 3, fontSize: 9 }}>STALE</span>}
          </span>
        )}
      </div>

      {live.escalation_reason && (
        <div style={{ fontSize: 11, color: '#f87171', marginTop: 5 }}>
          {live.escalation_reason}
        </div>
      )}

      {showBlockMask && blockMask.length > 0 && (
        <div style={{ marginTop: 6, borderTop: '0.5px solid rgba(255,255,255,0.07)', paddingTop: 5 }}>
          {isDeadlock && (
            <div style={{
              fontSize: 10, fontWeight: 700, color: '#f87171',
              background: 'rgba(248,113,113,0.08)',
              border: '0.5px solid rgba(248,113,113,0.3)',
              borderRadius: 4, padding: '3px 8px', marginBottom: 5,
            }}>
              DEADLOCK — HUMAN REQUIRED
            </div>
          )}
          {blockMask.map((entry, i) => (
            <div key={i} style={{ marginBottom: 3 }}>
              <span style={{
                fontSize: 10, fontFamily: 'monospace', color: '#f87171',
                marginRight: 4,
              }}>
                {entry.dimension}
              </span>
              {entry.recovery_action && (
                <span style={{ fontSize: 10, color: '#94a3b8' }}>
                  → {entry.recovery_action}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {showNotes && live.notes && live.notes.length > 0 && (
        <div style={{ marginTop: 5 }}>
          {live.notes.map((note, i) => (
            <div key={i} style={{ fontSize: 10, color: '#94a3b8', marginBottom: 2 }}>
              {note}
            </div>
          ))}
        </div>
      )}
    </BaseNode>
  )
}
