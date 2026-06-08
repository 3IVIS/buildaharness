import type { Node } from '@itsharness/canvas'
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
])

export function getExecutor(nodeType: string): ExecutorFn | undefined {
  return REGISTRY.get(nodeType)
}

export function registerExecutor(nodeType: string, fn: ExecutorFn): void {
  REGISTRY.set(nodeType, fn)
}
