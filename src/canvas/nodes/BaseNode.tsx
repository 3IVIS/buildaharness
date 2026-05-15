import { Handle, Position, useReactFlow } from '@xyflow/react'
import { useCanvasStore } from '../../store'
import {
  ADAPTER_LABELS, NODE_SUPPORT_MATRIX,
  type NodeType, type AdapterName, type SupportLevel, type RuntimeSupportOverride,
} from '../../spec/schema'

const ADAPTERS: AdapterName[] = ['langgraph', 'crewai', 'mastra', 'microsoft_agent_framework']

const NODE_COLORS: Record<NodeType, string> = {
  input:            'var(--c-input)',
  output:           'var(--c-output)',
  llm_call:         'var(--c-llm)',
  tool_invoke:      'var(--c-tool)',
  condition:        'var(--c-cond)',
  parallel_fork:    'var(--c-fork)',
  parallel_join:    'var(--c-join)',
  hitl_breakpoint:  'var(--c-hitl)',
  memory_read:      'var(--c-memr)',
  memory_write:     'var(--c-memw)',
  subgraph:         'var(--c-sub)',
  transform:        'var(--c-xform)',
  agent_role:       'var(--c-agent)',
  agent_debate:     'var(--c-debate)',
}

const NODE_TYPE_LABELS: Record<NodeType, string> = {
  input:            'input',
  output:           'output',
  llm_call:         'llm_call',
  tool_invoke:      'tool_invoke',
  condition:        'condition',
  parallel_fork:    'parallel_fork',
  parallel_join:    'parallel_join',
  hitl_breakpoint:  'hitl',
  memory_read:      'memory_read',
  memory_write:     'memory_write',
  subgraph:         'subgraph',
  transform:        'transform',
  agent_role:       'agent_role',
  agent_debate:     'agent_debate',
}

function getSupportLevel(type: NodeType, adapter: AdapterName, override?: RuntimeSupportOverride): SupportLevel {
  if (override?.[adapter]) return override[adapter] as SupportLevel
  return NODE_SUPPORT_MATRIX[type]?.[adapter] ?? 'missing'
}

interface BaseNodeProps {
  id:       string
  type:     NodeType
  selected: boolean
  data:     Record<string, unknown>
  /** Preview line shown below label */
  preview?: string
  children?: React.ReactNode
  /** Show left (target) handle */
  hasTarget?: boolean
  /** Show right (source) handle */
  hasSource?: boolean
}

export function BaseNode({ id, type, selected, data, preview, children, hasTarget = true, hasSource = true }: BaseNodeProps) {
  const selectNode   = useCanvasStore((s) => s.selectNode)
  const color        = NODE_COLORS[type]
  const label        = (data.label as string) || NODE_TYPE_LABELS[type]
  const runtimeOverride = data.runtime_support as RuntimeSupportOverride | undefined

  return (
    <div
      className={`cf-node${selected ? ' selected' : ''}`}
      onClick={() => selectNode(id)}
      style={{ borderLeftColor: color, borderLeftWidth: 3 }}
    >
      {/* Accent bar */}
      <div className="cf-node__accent" style={{ background: color, opacity: 0.7 }} />

      {/* Handles */}
      {hasTarget && (
        <Handle type="target" position={Position.Left}  style={{ background: color, borderColor: color }} />
      )}
      {hasSource && (
        <Handle type="source" position={Position.Right} style={{ background: color, borderColor: color }} />
      )}

      {/* Header */}
      <div className="cf-node__header">
        <span className="cf-node__badge" style={{ color }}>{NODE_TYPE_LABELS[type]}</span>
        <span className="cf-node__label">{label}</span>
      </div>

      {/* Preview / children */}
      {(preview || children) && (
        <div className="cf-node__body">
          {preview && <div className="cf-node__preview">{preview}</div>}
          {children}
        </div>
      )}

      {/* Runtime compat badges */}
      <div className="cf-node__compat">
        {ADAPTERS.map((rt) => {
          const level = getSupportLevel(type, rt, runtimeOverride)
          return (
            <span key={rt} className={`rt-badge rt-badge--${level}`} title={`${rt}: ${level}`}>
              {ADAPTER_LABELS[rt]}
            </span>
          )
        })}
      </div>
    </div>
  )
}
