import type { Node } from '../spec/schema'
import type { FlowState } from '../state'
import type { ExecutionContext } from '../context'
import type { ExecutorOutput } from './index'
import { FlowExecutionError } from '../errors'
import { FlowRuntime } from '../runtime'
import { resolveValue } from '../template'

export async function subgraphExecutor(node: Node, state: FlowState, context: ExecutionContext): Promise<ExecutorOutput> {
  if (node.type !== 'subgraph') throw new Error(`subgraphExecutor called with node type "${node.type}"`)

  context.eventBus.emit({ type: 'node:start', nodeId: node.id, nodeType: node.type })
  const start = Date.now()

  const nestedSpec = context.subgraphRegistry.get(node.flow_ref)
  if (!nestedSpec) {
    throw new FlowExecutionError({ nodeId: node.id, message: `subgraph node "${node.id}": flow_ref "${node.flow_ref}" not found in subgraphRegistry` })
  }

  // Build triggerData from parent state using input_map
  const triggerData: Record<string, unknown> = {}
  if (node.input_map) {
    for (const [childKey, parentExpr] of Object.entries(node.input_map)) {
      triggerData[childKey] = resolveValue(parentExpr, state)
    }
  }

  // Create a child context that shares LLMClient, ToolRegistry, memory adapters, eventBus, functions
  // but has independent HITL resolvers and branch results
  const childContext: ExecutionContext = {
    ...context,
    hitlResolvers: new Map(),
    branchResults: new Map(),
  }

  const nestedRuntime = new FlowRuntime()
  const nestedState = await nestedRuntime.execute(nestedSpec, triggerData, childContext)

  // Map nested output back to parent state using output_map
  const stateUpdate: Record<string, unknown> = {}
  if (node.output_map) {
    const nestedData = nestedState.toJSON()
    for (const [parentKey, childPath] of Object.entries(node.output_map)) {
      const parts = childPath.split('.')
      let value: unknown = nestedData
      for (const part of parts) {
        if (value === null || value === undefined) break
        value = (value as Record<string, unknown>)[part]
      }
      stateUpdate[parentKey] = value
    }
  }

  context.eventBus.emit({ type: 'node:complete', nodeId: node.id, nodeType: node.type, durationMs: Date.now() - start })

  return { stateUpdate }
}
