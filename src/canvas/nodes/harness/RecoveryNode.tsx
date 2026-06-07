import type { NodeProps } from '@xyflow/react'
import { BaseNode } from '../BaseNode'
import type { NodeData } from '../../../store'

const DEFAULT_STRATEGY_ORDER = [
  'DIRECT_EDIT', 'TRACE_EXEC', 'BROADER_SEARCH', 'REIMPLEMENT', 'MINIMAL_FIX', 'ESCALATE',
] as const

interface LiveRecoveryState {
  current_strategy?: string
  strategy_position?: number
  matched_pattern?: string
  pattern_confidence?: number
}

export function RecoveryNode({ id, selected, data }: NodeProps & { data: NodeData }) {
  const cfg = (data.harness_config as Record<string, unknown>) ?? {}
  const live = (data.live as LiveRecoveryState) ?? {}

  const strategyOrder = (cfg.strategy_order_override as string[]) ?? [...DEFAULT_STRATEGY_ORDER]
  const showPatternConf = (cfg.show_pattern_confidence as boolean) ?? true

  const currentStrategy = live.current_strategy ?? strategyOrder[0]
  const position = live.strategy_position ?? strategyOrder.indexOf(currentStrategy)
  const nextStrategy = position >= 0 && position < strategyOrder.length - 1
    ? strategyOrder[position + 1]
    : null

  const matchedPattern = live.matched_pattern
  const patternConf = live.pattern_confidence ?? 0

  return (
    <BaseNode id={id} type="recovery_node" selected={selected} data={data}>
      <div style={{ marginTop: 3 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            fontSize: 12, fontWeight: 700, color: '#fb923c',
            background: 'rgba(251,146,60,0.1)',
            border: '0.5px solid rgba(251,146,60,0.3)',
            padding: '2px 8px', borderRadius: 4,
          }}>
            {currentStrategy}
          </span>
          {nextStrategy && (
            <>
              <span style={{ fontSize: 10, color: '#475569' }}>→</span>
              <span style={{ fontSize: 10, color: '#64748b', fontFamily: 'monospace' }}>
                {nextStrategy}
              </span>
            </>
          )}
        </div>

        <div style={{ display: 'flex', gap: 2, marginTop: 6, alignItems: 'center' }}>
          {strategyOrder.map((s, i) => (
            <div
              key={s}
              title={s}
              style={{
                height: 5,
                flex: 1,
                borderRadius: 2,
                background: i === position
                  ? '#fb923c'
                  : i < position ? '#fb923c40' : 'rgba(255,255,255,0.07)',
                border: i === position ? '1px solid #fb923c' : 'none',
                transition: 'background 0.2s',
              }}
            />
          ))}
          <span style={{ fontSize: 9, color: '#94a3b8', fontFamily: 'monospace', marginLeft: 3, flexShrink: 0 }}>
            {position >= 0 ? position + 1 : '?'}/{strategyOrder.length}
          </span>
        </div>

        {showPatternConf && matchedPattern && (
          <div style={{
            marginTop: 6, padding: '4px 7px', borderRadius: 4,
            background: 'rgba(251,191,36,0.05)',
            border: '0.5px solid rgba(251,191,36,0.2)',
          }}>
            <div style={{ fontSize: 9, color: '#fbbf24', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 3 }}>
              ADVISORY
            </div>
            <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 3 }}>
              {matchedPattern}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <div style={{
                flex: 1, height: 3, background: 'rgba(255,255,255,0.07)',
                borderRadius: 2, overflow: 'hidden', maxWidth: 60,
              }}>
                <div style={{
                  width: `${patternConf * 100}%`, height: '100%',
                  background: '#fbbf24', borderRadius: 2,
                }} />
              </div>
              <span style={{ fontSize: 10, color: '#fbbf24', fontFamily: 'monospace' }}>
                {(patternConf * 100).toFixed(0)}%
              </span>
            </div>
          </div>
        )}
      </div>
    </BaseNode>
  )
}
