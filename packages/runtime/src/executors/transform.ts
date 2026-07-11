import type { Node } from '../spec/schema'
import type { FlowState } from '../state'
import type { ExecutionContext } from '../context'
import type { ExecutorOutput } from './index'
import { resolveValue } from '../template'

export async function transformExecutor(
  node: Node,
  state: FlowState,
  context: ExecutionContext,
): Promise<ExecutorOutput> {
  if (node.type !== 'transform') throw new Error(`transformExecutor called with node type "${node.type}"`)

  context.eventBus.emit({ type: 'node:start', nodeId: node.id, nodeType: node.type })
  const start = Date.now()

  const stateSnapshot = state.toJSON()
  let stateUpdate: Record<string, unknown> = {}

  if (node.mode === 'fn_ref') {
    if (!node.fn_ref) throw new Error(`transform node "${node.id}" mode=fn_ref but fn_ref is missing`)
    const fn = context.functions.get(node.fn_ref)
    if (!fn) throw new Error(`transform node "${node.id}" fn_ref "${node.fn_ref}" not found in FunctionRegistry`)
    stateUpdate = fn(stateSnapshot)
  } else if (node.mode === 'mapping') {
    if (node.output_map) {
      for (const [outputKey, sourceExpr] of Object.entries(node.output_map)) {
        stateUpdate[outputKey] = resolveValue(sourceExpr, state)
      }
    } else if (node.mapping) {
      for (const { from, to } of node.mapping) {
        stateUpdate[to] = stateSnapshot[from]
      }
    }
  }

  context.eventBus.emit({ type: 'node:complete', nodeId: node.id, nodeType: node.type, durationMs: Date.now() - start })

  return { stateUpdate }
}
