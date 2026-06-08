import { assertFlowSpec } from '@itsharness/canvas'
import type { FlowSpec } from '@itsharness/canvas'
import { FlowGraph } from './graph'
import { FlowState } from './state'
import type { ExecutionContext } from './context'
import { getExecutor } from './executors/index'
import {
  FlowExecutionError,
  NodeExecutionError,
  UnknownNodeTypeError,
  AbortedError,
} from './errors'

export class FlowRuntime {
  async execute(
    flowSpec: unknown,
    triggerData: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<FlowState> {
    // Throws immediately on invalid spec or unsupported spec_version
    const spec: FlowSpec = assertFlowSpec(flowSpec)

    const graph = new FlowGraph(spec.nodes, spec.edges)
    const state = new FlowState(spec.state_schema)

    // Store trigger data in state so InputExecutor can read it
    state.patch({ __triggerData__: triggerData })

    const roots = graph.roots()
    if (roots.length === 0) {
      throw new FlowExecutionError({ nodeId: 'graph', message: 'FlowSpec has no root node' })
    }

    let currentNodeId: string | null = roots[0]

    while (currentNodeId !== null) {
      if (context.signal.aborted) {
        throw new AbortedError({ nodeId: currentNodeId })
      }

      const node = graph.getNode(currentNodeId)
      if (!node) {
        throw new FlowExecutionError({ nodeId: currentNodeId, message: `Node "${currentNodeId}" not found in graph` })
      }

      const executor = getExecutor(node.type)
      if (!executor) {
        throw new UnknownNodeTypeError({ nodeId: node.id, nodeType: node.type })
      }

      let result
      try {
        result = await executor(node, state, context)
      } catch (err) {
        if (err instanceof FlowExecutionError) {
          context.eventBus.emit({ type: 'node:error', nodeId: node.id, error: err })
          throw err
        }
        const wrapped = new NodeExecutionError({ nodeId: node.id, cause: err })
        context.eventBus.emit({ type: 'node:error', nodeId: node.id, error: wrapped })
        throw wrapped
      }

      state.patch(result.stateUpdate)

      if (node.type === 'output') {
        // Remove internal trigger data from final state
        const finalData = state.toJSON()
        delete finalData['__triggerData__']
        return FlowState.fromJSON(finalData, spec.state_schema)
      }

      // Determine next node
      if (result.routeToNodeId != null) {
        currentNodeId = result.routeToNodeId
      } else {
        const successors = graph.successors(currentNodeId)
        currentNodeId = successors.length > 0 ? successors[0] : null
      }
    }

    // Reached end of graph without hitting an output node
    const finalData = state.toJSON()
    delete finalData['__triggerData__']
    return FlowState.fromJSON(finalData, spec.state_schema)
  }
}
