import type { NodeProps } from '@xyflow/react'
import { BaseNode } from '../BaseNode'
import type { NodeData } from '../../../store'

type LayerStatus = 'PASS' | 'FAIL' | 'SKIPPED' | 'PENDING'

interface LayerState {
  name: string
  status: LayerStatus
  enabled: boolean
  available: boolean
  unavailable_tool?: string
}

interface LiveVerificationGate {
  layers?: LayerState[]
}

const ALL_LAYERS = [
  'syntax', 'unit', 'integration', 'consistency', 'requirements',
  'assumptions', 'goal_correctness', 'evidence_sufficiency', 'output_contract_partial',
] as const

const STATUS_COLORS: Record<LayerStatus, string> = {
  PASS: '#4ade80',
  FAIL: '#f87171',
  SKIPPED: '#64748b',
  PENDING: '#fbbf24',
}

export function VerificationGateNode({ id, selected, data }: NodeProps & { data: NodeData }) {
  const cfg = (data.harness_config as Record<string, unknown>) ?? {}
  const live = (data.live as LiveVerificationGate) ?? {}
  const enabledLayers = (cfg.enabled_layers as string[]) ?? [...ALL_LAYERS]

  const layerStates: LayerState[] = live.layers ?? ALL_LAYERS.map((name) => ({
    name,
    status: 'PENDING',
    enabled: enabledLayers.includes(name),
    available: true,
  }))

  const passCnt = layerStates.filter((l) => l.status === 'PASS').length
  const failCnt = layerStates.filter((l) => l.status === 'FAIL').length
  const skipCnt = layerStates.filter((l) => l.status === 'SKIPPED').length

  return (
    <BaseNode id={id} type="verification_gate" selected={selected} data={data}>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 3 }}>
        {passCnt > 0 && (
          <span style={{
            fontSize: 10, fontFamily: 'monospace', color: '#4ade80',
            background: 'rgba(74,222,128,0.08)', border: '0.5px solid rgba(74,222,128,0.25)',
            padding: '1px 5px', borderRadius: 3,
          }}>
            {passCnt} PASS
          </span>
        )}
        {failCnt > 0 && (
          <span style={{
            fontSize: 10, fontFamily: 'monospace', color: '#f87171',
            background: 'rgba(248,113,113,0.08)', border: '0.5px solid rgba(248,113,113,0.25)',
            padding: '1px 5px', borderRadius: 3,
          }}>
            {failCnt} FAIL
          </span>
        )}
        {skipCnt > 0 && (
          <span style={{
            fontSize: 10, fontFamily: 'monospace', color: '#64748b',
            background: 'rgba(100,116,139,0.08)', border: '0.5px solid rgba(100,116,139,0.25)',
            padding: '1px 5px', borderRadius: 3,
          }}>
            {skipCnt} SKIP
          </span>
        )}
      </div>

      <div style={{ marginTop: 5, borderTop: '0.5px solid rgba(255,255,255,0.07)', paddingTop: 4 }}>
        {layerStates.map((layer) => {
          const locked = !layer.available
          const color = STATUS_COLORS[layer.status]
          return (
            <div key={layer.name} style={{
              display: 'flex', alignItems: 'center', gap: 4,
              marginBottom: 3, opacity: locked ? 0.5 : 1,
            }}>
              <input
                type="checkbox"
                readOnly
                checked={layer.enabled && layer.available}
                disabled={locked}
                style={{ width: 10, height: 10, cursor: 'default', flexShrink: 0 }}
                title={locked ? `${layer.unavailable_tool ?? 'tool'} unavailable` : undefined}
              />
              <span style={{
                fontSize: 10, color: locked ? '#475569' : '#94a3b8',
                fontFamily: 'monospace', flex: 1, minWidth: 0,
              }}>
                {layer.name}
              </span>
              <span
                style={{
                  fontSize: 9, fontWeight: 600, color, padding: '0 4px',
                  borderRadius: 3, background: `${color}12`,
                  border: `0.5px solid ${color}40`,
                  fontFamily: 'monospace', flexShrink: 0,
                }}
                title={locked ? `SKIPPED — ${layer.unavailable_tool ?? 'required tool'} unavailable` : undefined}
              >
                {locked ? 'SKIPPED' : layer.status}
              </span>
            </div>
          )
        })}
      </div>
    </BaseNode>
  )
}
