import type { Node } from '@buildaharness/canvas'
import type { FlowState } from '../state'
import type { ExecutionContext } from '../context'
import { inputExecutor } from './input'
import { llmCallExecutor } from './llm-call'
import { transformExecutor } from './transform'
import { conditionExecutor } from './condition'
import { outputExecutor } from './output'
import { parallelForkExecutor } from './parallel-fork'
import { parallelJoinExecutor } from './parallel-join'
import { memoryReadExecutor } from './memory-read'
import { memoryWriteExecutor } from './memory-write'
import { toolInvokeExecutor } from './tool-invoke'
import { hitlBreakpointExecutor } from './hitl-breakpoint'
import { agentRoleExecutor } from './agent-role'
import { agentDebateExecutor } from './agent-debate'
import { subgraphExecutor } from './subgraph'
import { processConceptExecutor } from './process-concept'

export interface ExecutorOutput {
  stateUpdate: Record<string, unknown>
  routeToNodeId?: string
  tokenCount?: number
}

export type ExecutorFn = (
  node: Node,
  state: FlowState,
  context: ExecutionContext,
) => Promise<ExecutorOutput>

// Passthrough stub — emits lifecycle events and returns empty state update.
// Used for node types scheduled for later phases (hitl_breakpoint/agent_role/agent_debate/subgraph → P4).
export async function _stubExecutor(node: Node, _state: FlowState, context: ExecutionContext): Promise<ExecutorOutput> {
  context.eventBus.emit({ type: 'node:start', nodeId: node.id, nodeType: node.type })
  context.eventBus.emit({ type: 'node:complete', nodeId: node.id, nodeType: node.type, durationMs: 0 })
  return { stateUpdate: {} }
}

const REGISTRY = new Map<string, ExecutorFn>([
  ['input', inputExecutor],
  ['llm_call', llmCallExecutor],
  ['transform', transformExecutor],
  ['condition', conditionExecutor],
  ['output', outputExecutor],
  // P2 parallel executors
  ['parallel_fork', parallelForkExecutor],
  ['parallel_join', parallelJoinExecutor],
  // P3 executors
  ['memory_read', memoryReadExecutor],
  ['memory_write', memoryWriteExecutor],
  ['tool_invoke', toolInvokeExecutor],
  // P4 executors
  ['hitl_breakpoint', hitlBreakpointExecutor],
  ['agent_role', agentRoleExecutor],
  ['agent_debate', agentDebateExecutor],
  ['subgraph', subgraphExecutor],
  // P-PC executor
  ['process_concept', processConceptExecutor],
  // Harness node types — executed server-side by the Python adapter; the runtime
  // treats them as passthrough stubs that emit lifecycle events but do not
  // modify state. This allows harness-enabled flows (coaching, etc.) to be
  // loaded and traversed by the client-side runtime without error.
  ['gather_evidence', _stubExecutor],
  ['update_world_model', _stubExecutor],
  ['apply_tool_reliability', _stubExecutor],
  ['recovery_node', _stubExecutor],
  // Canvas observability node types (display-only, no execution semantics)
  ['world_model', _stubExecutor],
  ['hypothesis_set', _stubExecutor],
  ['control_state', _stubExecutor],
  ['task_graph_node', _stubExecutor],
  ['verification_gate', _stubExecutor],
  ['evidence_store_node', _stubExecutor],
  ['experience_store_node', _stubExecutor],
  ['reviewer_pass', _stubExecutor],
])

export function getExecutor(nodeType: string): ExecutorFn | undefined {
  return REGISTRY.get(nodeType)
}

export function registerExecutor(nodeType: string, fn: ExecutorFn): void {
  REGISTRY.set(nodeType, fn)
}

export function unregisterExecutor(nodeType: string): void {
  REGISTRY.delete(nodeType)
}
