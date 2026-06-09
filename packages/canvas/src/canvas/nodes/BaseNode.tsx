import { Handle, Position } from '@xyflow/react'
import {
  LogIn, LogOut, Sparkles, Wrench, GitBranch, GitFork, GitMerge,
  UserCheck, BookOpen, BookMarked, Layers, Shuffle, Bot, Users,
  AlertTriangle, Brain, Lightbulb, Shield, Network, CheckCircle2,
  RefreshCw, Database, BarChart3, Eye,
  type LucideIcon,
} from 'lucide-react'
import { useCanvasStore, type NodeExecStat } from '../../store/context'
import {
  ADAPTER_LABELS, NODE_SUPPORT_MATRIX,
  type AnyNodeType, type AdapterName, type SupportLevel, type RuntimeSupportOverride,
} from '../../spec/schema'

const ADAPTERS: AdapterName[] = ['langgraph', 'crewai', 'mastra', 'microsoft_agent_framework']

// ──────────────────────────────────────────────────────────────────────────
// Palette · one hue per FAMILY, then differentiate by glyph modifier.
// memory_read/memory_write → one cyan + ↑/↓
// parallel_fork/parallel_join → one green + ⊕/⊖
// agent_role/agent_debate → one magenta + ◉/⋯
// Harness nodes → rose/pink family (#fb7185) with per-node variation.
// ──────────────────────────────────────────────────────────────────────────
export const NODE_HEX: Record<AnyNodeType, string> = {
  input:                  '#3b82f6',
  output:                 '#6b7280',
  llm_call:               '#8b5cf6',
  tool_invoke:            '#14b8a6',
  condition:              '#f59e0b',
  parallel_fork:          '#22c55e',
  parallel_join:          '#22c55e',
  hitl_breakpoint:        '#f97316',
  memory_read:            '#06b6d4',
  memory_write:           '#06b6d4',
  subgraph:               '#64748b',
  transform:              '#facc15',
  agent_role:             '#ec4899',
  agent_debate:           '#ec4899',
  // Harness nodes
  world_model:            '#fb7185',
  hypothesis_set:         '#c084fc',
  gather_evidence:        '#34d399',
  apply_tool_reliability: '#2dd4bf',
  update_world_model:     '#60a5fa',
  control_state:          '#f87171',
  task_graph_node:        '#60a5fa',
  verification_gate:      '#4ade80',
  recovery_node:          '#fb923c',
  evidence_store_node:    '#67e8f9',
  experience_store_node:  '#a78bfa',
  reviewer_pass:          '#fb7185',
}

export const NODE_ICONS: Record<AnyNodeType, LucideIcon> = {
  input: LogIn, output: LogOut, llm_call: Sparkles, tool_invoke: Wrench,
  condition: GitBranch, parallel_fork: GitFork, parallel_join: GitMerge,
  hitl_breakpoint: UserCheck, memory_read: BookOpen, memory_write: BookMarked,
  subgraph: Layers, transform: Shuffle, agent_role: Bot, agent_debate: Users,
  // Harness nodes
  world_model: Brain, hypothesis_set: Lightbulb,
  gather_evidence: Database, apply_tool_reliability: Wrench,
  update_world_model: Brain,
  control_state: Shield, task_graph_node: Network,
  verification_gate: CheckCircle2, recovery_node: RefreshCw,
  evidence_store_node: Database, experience_store_node: BarChart3,
  reviewer_pass: Eye,
}

export const NODE_GLYPH_MOD: Partial<Record<AnyNodeType, string>> = {
  memory_read:   '↑',
  memory_write:  '↓',
  parallel_fork: '⊕',
  parallel_join: '⊖',
  agent_role:    '◉',
  agent_debate:  '⋯',
}

export const NODE_TYPE_LABELS: Record<AnyNodeType, string> = {
  input: 'input', output: 'output', llm_call: 'llm_call', tool_invoke: 'tool_invoke',
  condition: 'condition', parallel_fork: 'parallel_fork', parallel_join: 'parallel_join',
  hitl_breakpoint: 'hitl', memory_read: 'memory_read', memory_write: 'memory_write',
  subgraph: 'subgraph', transform: 'transform', agent_role: 'agent_role', agent_debate: 'agent_debate',
  // Harness nodes
  world_model: 'world_model', hypothesis_set: 'hypothesis_set',
  gather_evidence: 'gather_evidence', apply_tool_reliability: 'apply_tool_rel',
  update_world_model: 'update_wm',
  control_state: 'control_state', task_graph_node: 'task_graph',
  verification_gate: 'verify_gate', recovery_node: 'recovery',
  evidence_store_node: 'evidence_store', experience_store_node: 'exp_store',
  reviewer_pass: 'reviewer_pass',
}

function getSupportLevel(
  type: AnyNodeType,
  adapter: AdapterName,
  override?: RuntimeSupportOverride,
): SupportLevel {
  if (override?.[adapter]) return override[adapter] as SupportLevel
  return NODE_SUPPORT_MATRIX[type]?.[adapter] ?? 'missing'
}

interface BaseNodeProps {
  id:         string
  type:       AnyNodeType
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
      {/* §4 — handle labels (autohide; revealed on .cf-node:hover via CSS) */}
      {hasTarget && <span className="cf-handle-label cf-handle-label--left">in</span>}
      {hasSource && (
        <span className="cf-handle-label cf-handle-label--right">
          {type === 'condition'     ? 'branches'
          : type === 'parallel_fork' ? 'targets'
          : type === 'tool_invoke'   ? 'ok'
          : 'out'}
        </span>
      )}

      <div className="cf-node__header">
        <span className="cf-node__icon-stack">
          <span className="cf-node__icon" style={{ color: hex }}>
            <Icon size={14} strokeWidth={1.75} />
          </span>
          {glyph && <span className="cf-node__glyph-mod">{glyph}</span>}
        </span>

        <span className="cf-node__label">{label}</span>

        {/* §15 — single-runtime compat-pin removed from the header;
            the autohide 4-cell strip at the bottom is the canonical surface. */}
      </div>

      {(preview || children) && (
        <div className="cf-node__body">
          {preview && <div className="cf-node__preview">{preview}</div>}
          {children}
        </div>
      )}

      {execStat && <ExecBadge stat={execStat} />}

      {hasError && (
        <div className="cf-node__error">
          <AlertTriangle size={11} strokeWidth={2} />
          <span>{nodeErrors[0].message}</span>
          {nodeErrors.length > 1 && (
            <span className="cf-node__error-more">+{nodeErrors.length - 1}</span>
          )}
        </div>
      )}

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

/** Map a [0, 1] score to a status colour using the roadmap thresholds. */
function scoreColor(score: number): string {
  if (score > 0.8) return 'var(--rt-full)'   // green
  if (score > 0.5) return 'var(--amber)'     // amber
  return '#f87171'                           // red  (var(--red))
}

/** Map a score to a single Unicode circle glyph that communicates quality
 *  without relying on colour alone (accessibility). */
function scoreGlyph(score: number): string {
  if (score > 0.8) return '●'   // full  — good
  if (score > 0.5) return '◐'   // half  — warn
  return '○'                    // empty — poor
}

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

      {/* Quality arc — rendered only when an LLM-as-judge score is available.
          Score is keyed by Langfuse observationId; wired to nodeId in a future
          Phase 3 follow-up (node_id → observationId mapping).  Until then this
          renders as a graceful no-op (score === undefined). */}
      {stat.score != null && (
        <>
          <span className="exec-sep">·</span>
          <span
            className="exec-quality"
            style={{ color: scoreColor(stat.score), fontSize: 10 }}
            title={`Quality score: ${(stat.score * 100).toFixed(0)}%`}
            aria-label={`Quality ${(stat.score * 100).toFixed(0)}%`}
          >
            {scoreGlyph(stat.score)}
          </span>
        </>
      )}
    </div>
  )
}
