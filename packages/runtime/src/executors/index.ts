import type { Node } from '@itsharness/canvas'
import type { FlowState } from '../state'
import type { ExecutionContext } from '../context'
import { inputExecutor } from './input'
import { llmCallExecutor } from './llm-call'
import { transformExecutor } from './transform'
import { conditionExecutor } from './condition'
import { outputExecutor } from './output'

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
// Used for node types scheduled for later phases (memory_read/write → P3,
// hitl_breakpoint/agent_role/agent_debate/subgraph → P4).
async function _stubExecutor(node: Node, _state: FlowState, context: ExecutionContext): Promise<ExecutorOutput> {
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
  // P3 stubs — replaced by full implementations in Phase 3
  ['memory_read', _stubExecutor],
  ['memory_write', _stubExecutor],
  ['tool_invoke', _stubExecutor],
])

export function getExecutor(nodeType: string): ExecutorFn | undefined {
  return REGISTRY.get(nodeType)
}

export function registerExecutor(nodeType: string, fn: ExecutorFn): void {
  REGISTRY.set(nodeType, fn)
}
