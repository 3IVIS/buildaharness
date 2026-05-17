import { Handle, Position } from '@xyflow/react'
import {
  LogIn, LogOut, Sparkles, Wrench, GitBranch, GitFork, GitMerge,
  UserCheck, BookOpen, BookMarked, Layers, Shuffle, Bot, Users,
  AlertTriangle,
  type LucideIcon,
} from 'lucide-react'
import { useCanvasStore, type NodeExecStat } from '../../store'
import {
  ADAPTER_LABELS, NODE_SUPPORT_MATRIX,
  type NodeType, type AdapterName, type SupportLevel, type RuntimeSupportOverride,
} from '../../spec/schema'

const ADAPTERS: AdapterName[] = ['langgraph', 'crewai', 'mastra', 'microsoft_agent_framework']

// ──────────────────────────────────────────────────────────────────────────
// Palette · one hue per FAMILY, then differentiate by glyph modifier.
// memory_read/memory_write → one cyan + ↑/↓
// parallel_fork/parallel_join → one green + ⊕/⊖
// agent_role/agent_debate → one magenta + ◉/⋯
// transform shifted to amber so it no longer collides with llm_call (violet).
// ──────────────────────────────────────────────────────────────────────────
export const NODE_HEX: Record<NodeType, string> = {
  input:            '#3b82f6',
  output:           '#6b7280',
  llm_call:         '#8b5cf6',
  tool_invoke:      '#14b8a6',
  condition:        '#f59e0b',
  parallel_fork:    '#22c55e',
  parallel_join:    '#22c55e',  // ← was #16a34a — same hue as fork
  hitl_breakpoint:  '#f97316',
  memory_read:      '#06b6d4',
  memory_write:     '#06b6d4',  // ← was #0891b2 — same hue as read
  subgraph:         '#64748b',
  transform:        '#facc15',  // ← was #a855f7 — moved off llm violet
  agent_role:       '#ec4899',
  agent_debate:     '#ec4899',  // ← was #d946ef — same hue as role
}

export const NODE_ICONS: Record<NodeType, LucideIcon> = {
  input: LogIn, output: LogOut, llm_call: Sparkles, tool_invoke: Wrench,
  condition: GitBranch, parallel_fork: GitFork, parallel_join: GitMerge,
  hitl_breakpoint: UserCheck, memory_read: BookOpen, memory_write: BookMarked,
  subgraph: Layers, transform: Shuffle, agent_role: Bot, agent_debate: Users,
}

// Glyph modifier — small circle that sits on the bottom-right of the icon
// to distinguish family members that share a hue.
export const NODE_GLYPH_MOD: Partial<Record<NodeType, string>> = {
  memory_read:   '↑',
  memory_write:  '↓',
  parallel_fork: '⊕',
  parallel_join: '⊖',
  agent_role:    '◉',
  agent_debate:  '⋯',
}

export const NODE_TYPE_LABELS: Record<NodeType, string> = {
  input: 'input', output: 'output', llm_call: 'llm_call', tool_invoke: 'tool_invoke',
  condition: 'condition', parallel_fork: 'parallel_fork', parallel_join: 'parallel_join',
  hitl_breakpoint: 'hitl', memory_read: 'memory_read', memory_write: 'memory_write',
  subgraph: 'subgraph', transform: 'transform', agent_role: 'agent_role', agent_debate: 'agent_debate',
}

function getSupportLevel(
  type: NodeType,
  adapter: AdapterName,
  override?: RuntimeSupportOverride,
): SupportLevel {
  if (override?.[adapter]) return override[adapter] as SupportLevel
  return NODE_SUPPORT_MATRIX[type]?.[adapter] ?? 'missing'
}

interface BaseNodeProps {
  id:         string
  type:       NodeType
  selected:   boolean
  data:       Record<string, unknown>
  preview?:   string
  children?:  React.ReactNode
  hasTarget?: boolean
  hasSource?: boolean
}

export function BaseNode({
  id, type, selected, data, preview, children,
  hasTarget = true, hasSource = true,
}: BaseNodeProps) {
  const selectNode       = useCanvasStore((s) => s.selectNode)
  const preferredAdapter = useCanvasStore((s) => s.flowMeta.runtimeHints?.preferred_adapter)
  const execStat         = useCanvasStore((s) => s.execStats[id])

  // Cross-ref errors for this node — surfaces validation INLINE on the canvas
  // instead of forcing the user to consult the Problems panel.
  const nodeErrors = useCanvasStore((s) =>
    s.crossRefErrors.filter((e) => e.nodeId === id),
  )

  const hex    = NODE_HEX[type]
  const Icon   = NODE_ICONS[type]
  const glyph  = NODE_GLYPH_MOD[type]
  const label  = (data.label as string) || NODE_TYPE_LABELS[type]
  const runtimeOverride = data.runtime_support as RuntimeSupportOverride | undefined

  const pinnedLevel: SupportLevel | null = preferredAdapter
    ? getSupportLevel(type, preferredAdapter, runtimeOverride)
    : null

  const hasWarning = pinnedLevel === 'partial'
  const hasMissing = pinnedLevel === 'missing'
  const hasError   = nodeErrors.length > 0

  return (
    <div
      className={[
        'cf-node',
        selected   ? 'selected'        : '',
        hasError   ? 'cf-node--error'  : '',
        hasMissing ? 'cf-node--absent' : '',
        hasWarning ? 'cf-node--warn'   : '',
        execStat?.status === 'pending' ? 'cf-node--exec-pending' : '',
        execStat?.status === 'running' ? 'cf-node--exec-running' : '',
        execStat?.status === 'paused'  ? 'cf-node--exec-paused'  : '',
        execStat?.status === 'done'    ? 'cf-node--exec-done'    : '',
        execStat?.status === 'error'   ? 'cf-node--exec-error'   : '',
      ].filter(Boolean).join(' ')}
      onClick={() => selectNode(id)}
      style={{ borderLeftColor: hex }}
    >
      {hasTarget && (
        <Handle type="target" position={Position.Left}
          style={{ background: hex, borderColor: hex }} />
      )}
      {hasSource && (
        <Handle type="source" position={Position.Right}
          style={{ background: hex, borderColor: hex }} />
      )}

      {/* Header — no tinted background; icon + glyph + label + pinned-compat pill */}
      <div className="cf-node__header">
        <span className="cf-node__icon-stack">
          <span className="cf-node__icon" style={{ color: hex }}>
            <Icon size={14} strokeWidth={1.75} />
          </span>
          {glyph && <span className="cf-node__glyph-mod">{glyph}</span>}
        </span>

        <span className="cf-node__label">{label}</span>

        {/* Single pinned-compat pill by default; full row revealed on hover/select */}
        {preferredAdapter && (
          <span
            className={`compat-pin compat-pin--${pinnedLevel ?? 'missing'}`}
            title={`${preferredAdapter}: ${pinnedLevel}`}
          >
            {(hasWarning || hasMissing) && (
              <AlertTriangle size={9} strokeWidth={2} />
            )}
            {ADAPTER_LABELS[preferredAdapter]}
          </span>
        )}
      </div>

      {(preview || children) && (
        <div className="cf-node__body">
          {preview && <div className="cf-node__preview">{preview}</div>}
          {children}
        </div>
      )}

      {/* Exec telemetry — promoted ABOVE the compat row so it's the most
          eye-catching info during a live run. Renders only when populated. */}
      {execStat && <ExecBadge stat={execStat} />}

      {/* Cross-ref error footer — same red palette as cf-node--absent.
          Click on the node opens the panel where the broken field lives. */}
      {hasError && (
        <div className="cf-node__error">
          <AlertTriangle size={11} strokeWidth={2} />
          <span>{nodeErrors[0].message}</span>
          {nodeErrors.length > 1 && (
            <span className="cf-node__error-more">+{nodeErrors.length - 1}</span>
          )}
        </div>
      )}

      {/* Full 4-runtime compat row — hidden by default, revealed on hover/select.
          Power users who want the matrix can still see it; everyone else gets
          a clean node body. */}
      <div className="cf-node__compat--full">
        {ADAPTERS.map((rt) => {
          const level    = getSupportLevel(type, rt, runtimeOverride)
          const isPinned = preferredAdapter === rt
          const isDimmed = preferredAdapter != null && !isPinned
          return (
            <span
              key={rt}
              className={`rt-badge rt-badge--${level}${isPinned ? ' rt-badge--pinned' : ''}`}
              title={`${rt}: ${level}`}
              style={{ opacity: isDimmed ? 0.45 : 1 }}
            >
              {ADAPTER_LABELS[rt]}
            </span>
          )
        })}
      </div>
    </div>
  )
}

// ─── Exec badge ───────────────────────────────────────────────────────────────
// Phase 2: populated with real data via websocket + Langfuse spans.

function ExecBadge({ stat }: { stat: NodeExecStat }) {
  if (stat.status === 'pending') {
    return (
      <div className="cf-node__exec-badge" data-status="pending">
        <span className="exec-dot" style={{ background: 'var(--hint)' }} title="queued" />
        <span className="exec-stat" style={{ color: 'var(--hint)' }}>queued</span>
      </div>
    )
  }

  const tokLabel = stat.tokens != null ? `${stat.tokens.toLocaleString()} tok` : '-- tok'
  const msLabel  = stat.ms     != null ? `${stat.ms.toLocaleString()} ms`      : '-- ms'

  const statusColor =
    stat.status === 'running' ? 'var(--blue)'  :
    stat.status === 'error'   ? '#ef4444'      :
                                'var(--rt-full)'

  return (
    <div className="cf-node__exec-badge" data-status={stat.status}>
      <span className="exec-dot" style={{ background: statusColor }} title={stat.status} />
      <span className="exec-stat">{tokLabel}</span>
      <span className="exec-sep">·</span>
      <span className="exec-stat">{msLabel}</span>
    </div>
  )
}
