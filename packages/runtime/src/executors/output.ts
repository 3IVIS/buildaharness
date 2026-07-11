import type { Node } from '../spec/schema'
import type { FlowState } from '../state'
import type { ExecutionContext } from '../context'
import type { ExecutorOutput } from './index'

export async function outputExecutor(
  node: Node,
  state: FlowState,
  context: ExecutionContext,
): Promise<ExecutorOutput> {
  if (node.type !== 'output') throw new Error(`outputExecutor called with node type "${node.type}"`)

  context.eventBus.emit({ type: 'node:start', nodeId: node.id, nodeType: node.type })
  const start = Date.now()

  const finalState = state.toJSON()

  if (node.input_schema) {
    const schema = node.input_schema as Record<string, unknown>
    if (schema.required && Array.isArray(schema.required)) {
      for (const field of schema.required as string[]) {
        if (finalState[field] === undefined) {
          context.eventBus.emit({
            type: 'node:error',
            nodeId: node.id,
            error: new Error(`output node "${node.id}" schema validation warning: required field "${field}" missing`),
          })
        }
      }
    }
  }

  context.eventBus.emit({ type: 'node:complete', nodeId: node.id, nodeType: node.type, durationMs: Date.now() - start })
  context.eventBus.emit({ type: 'flow:complete', finalState })

  return { stateUpdate: {} }
}
