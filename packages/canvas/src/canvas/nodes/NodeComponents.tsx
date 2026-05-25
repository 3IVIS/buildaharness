import type { NodeProps } from '@xyflow/react'
import { BaseNode } from './BaseNode'
import type { NodeData } from '../../store/context'

// ─── Helpers ───────────────────────────────────────────────────────────────

function trunc(s: string | undefined, n = 38) {
  if (!s) return ''
  return s.length > n ? s.slice(0, n) + '…' : s
}

// ─── input ─────────────────────────────────────────────────────────────────

export function InputNode({ id, selected, data }: NodeProps & { data: NodeData }) {
  // §4 — spec: input → no summary
  return (
    <BaseNode id={id} type="input" selected={selected} data={data} hasTarget={false} />
  )
}

// ─── output ────────────────────────────────────────────────────────────────

export function OutputNode({ id, selected, data }: NodeProps & { data: NodeData }) {
  // §4 — spec: output → no summary
  return (
    <BaseNode id={id} type="output" selected={selected} data={data} hasSource={false} />
  )
}

// ─── llm_call ──────────────────────────────────────────────────────────────

export function LlmCallNode({ id, selected, data }: NodeProps & { data: NodeData }) {
  type PR = { name: string; version?: number; label?: string }
  const promptRef = data.prompt_ref as PR | undefined
  // §4 — spec: llm_call → `model || 'default model'`
  const params  = (data.model_params as { model?: string } | undefined) ?? {}
  const preview = params.model || 'default model'

  // Small Langfuse pill badge — shown when the node uses a managed prompt.
  const promptPill = promptRef?.name ? (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 3,
      marginTop: 3,
      padding: '1px 6px',
      borderRadius: 4,
      fontSize: 10,
      fontWeight: 500,
      background: 'rgba(167,139,250,0.12)',
      border: '0.5px solid rgba(167,139,250,0.3)',
      color: '#a78bfa',
      letterSpacing: '0.01em',
      maxWidth: '100%',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }}>
      ⚡ {promptRef.name}
      {promptRef.version != null && (
        <span style={{ opacity: 0.7 }}> v{promptRef.version}</span>
      )}
    </div>
  ) : null

  return (
    <BaseNode id={id} type="llm_call" selected={selected} data={data}
      preview={preview}>
      {promptPill}
    </BaseNode>
  )
}

// ─── tool_invoke ───────────────────────────────────────────────────────────

export function ToolInvokeNode({ id, selected, data }: NodeProps & { data: NodeData }) {
  return (
    <BaseNode id={id} type="tool_invoke" selected={selected} data={data}
      preview={`tool: ${(data.tool_id as string) || '(none)'}`} />
  )
}

// ─── condition ─────────────────────────────────────────────────────────────

export function ConditionNode({ id, selected, data }: NodeProps & { data: NodeData }) {
  const branches = (data.branches as { condition: { expr?: string }; target: string }[]) ?? []
  const preview  = branches.length
    ? `${branches.length} branch${branches.length > 1 ? 'es' : ''} + default`
    : 'no branches'
  return (
    <BaseNode id={id} type="condition" selected={selected} data={data} preview={preview} />
  )
}

// ─── parallel_fork ─────────────────────────────────────────────────────────

export function ParallelForkNode({ id, selected, data }: NodeProps & { data: NodeData }) {
  const targets = (data.targets as string[]) ?? []
  return (
    <BaseNode id={id} type="parallel_fork" selected={selected} data={data}
      preview={targets.length ? `→ ${targets.join(', ')}` : 'no targets'} />
  )
}

// ─── parallel_join ─────────────────────────────────────────────────────────

export function ParallelJoinNode({ id, selected, data }: NodeProps & { data: NodeData }) {
  // §4 — spec: parallel_join → no summary
  return (
    <BaseNode id={id} type="parallel_join" selected={selected} data={data} />
  )
}

// ─── hitl_breakpoint ───────────────────────────────────────────────────────

export function HitlBreakpointNode({ id, selected, data }: NodeProps & { data: NodeData }) {
  // §4 — spec: hitl_breakpoint → first ~40 chars of `prompt`
  const prompt = (data.prompt as string) || ''
  return (
    <BaseNode id={id} type="hitl_breakpoint" selected={selected} data={data}
      preview={trunc(prompt, 40) || '— no prompt —'} />
  )
}

// ─── memory_read ───────────────────────────────────────────────────────────

export function MemoryReadNode({ id, selected, data }: NodeProps & { data: NodeData }) {
  const mode    = (data.retrieval_mode as string) ?? 'key_value'
  const storeId = (data.store_id as string) || '(none)'
  return (
    <BaseNode id={id} type="memory_read" selected={selected} data={data}
      preview={`${storeId} · ${mode}`} />
  )
}

// ─── memory_write ──────────────────────────────────────────────────────────

export function MemoryWriteNode({ id, selected, data }: NodeProps & { data: NodeData }) {
  const storeId = (data.store_id as string) || '(none)'
  const mode    = (data.write_mode as string) ?? 'upsert'
  return (
    <BaseNode id={id} type="memory_write" selected={selected} data={data}
      preview={`${storeId} · ${mode}`} />
  )
}

// ─── subgraph ──────────────────────────────────────────────────────────────

export function SubgraphNode({ id, selected, data }: NodeProps & { data: NodeData }) {
  return (
    <BaseNode id={id} type="subgraph" selected={selected} data={data}
      preview={`ref: ${(data.flow_ref as string) || '(none)'}`} />
  )
}

// ─── transform ─────────────────────────────────────────────────────────────

export function TransformNode({ id, selected, data }: NodeProps & { data: NodeData }) {
  const mode    = (data.mode as string) ?? 'mapping'
  const mapping = (data.mapping as { from: string; to: string }[]) ?? []
  const preview = mode === 'mapping'
    ? (mapping.length ? `${mapping.length} mapping${mapping.length > 1 ? 's' : ''}` : 'no mappings')
    : `fn: ${trunc(data.fn_ref as string, 30) || '(none)'}`
  return (
    <BaseNode id={id} type="transform" selected={selected} data={data} preview={preview} />
  )
}

// ─── agent_role ────────────────────────────────────────────────────────────

export function AgentRoleNode({ id, selected, data }: NodeProps & { data: NodeData }) {
  const config = (data.config as { agent_ref?: string; task_description?: string }) ?? {}
  return (
    <BaseNode id={id} type="agent_role" selected={selected} data={data}
      preview={`agent: ${config.agent_ref || '(none)'}`} />
  )
}

// ─── agent_debate ──────────────────────────────────────────────────────────

export function AgentDebateNode({ id, selected, data }: NodeProps & { data: NodeData }) {
  const config  = (data.config as { agents?: string[]; max_rounds?: number }) ?? {}
  const agents  = config.agents ?? []
  const rounds  = config.max_rounds ?? 10
  return (
    <BaseNode id={id} type="agent_debate" selected={selected} data={data}
      preview={`${agents.length} agents · ${rounds} rounds`} />
  )
}
