import type { Node } from '@itsharness/canvas'
import type { FlowState } from '../state'
import type { ExecutionContext } from '../context'
import type { ExecutorOutput } from './index'
import { resolveTemplate, resolveValue } from '../template'

export async function memoryWriteExecutor(
  node: Node,
  state: FlowState,
  context: ExecutionContext,
): Promise<ExecutorOutput> {
  if (node.type !== 'memory_write') throw new Error(`memoryWriteExecutor called with node type "${node.type}"`)

  context.eventBus.emit({ type: 'node:start', nodeId: node.id, nodeType: node.type })
  const start = Date.now()

  const adapter = context.memoryAdapters.get(node.store_id)
  if (!adapter) {
    const err = new Error(`memory_write node "${node.id}": no adapter registered for store_id "${node.store_id}"`)
    context.eventBus.emit({ type: 'node:error', nodeId: node.id, error: err })
    return { stateUpdate: {} }
  }

  const key = resolveTemplate(node.key_expr, state)
  const value = resolveValue(node.value_expr, state)
  const writeMode = node.write_mode ?? 'upsert'

  await adapter.set(key, value, writeMode)

  context.eventBus.emit({
    type: 'node:complete',
    nodeId: node.id,
    nodeType: node.type,
    durationMs: Date.now() - start,
  })

  return { stateUpdate: {} }
}
