import type { Node } from '@buildaharness/canvas'
import type { FlowState } from '../state'
import type { ExecutionContext } from '../context'
import type { ExecutorOutput } from './index'

export async function parallelForkExecutor(
  node: Node,
  _state: FlowState,
  context: ExecutionContext,
): Promise<ExecutorOutput> {
  const start = Date.now()
  context.eventBus.emit({ type: 'node:start', nodeId: node.id, nodeType: node.type })
  context.eventBus.emit({ type: 'node:complete', nodeId: node.id, nodeType: node.type, durationMs: Date.now() - start })
  return { stateUpdate: {} }
}
