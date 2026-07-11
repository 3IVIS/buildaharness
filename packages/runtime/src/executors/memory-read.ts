import type { Node } from '../spec/schema'
import type { FlowState } from '../state'
import type { ExecutionContext } from '../context'
import type { ExecutorOutput } from './index'
import { resolveTemplate } from '../template'

export async function memoryReadExecutor(
  node: Node,
  state: FlowState,
  context: ExecutionContext,
): Promise<ExecutorOutput> {
  if (node.type !== 'memory_read') throw new Error(`memoryReadExecutor called with node type "${node.type}"`)

  context.eventBus.emit({ type: 'node:start', nodeId: node.id, nodeType: node.type })
  const start = Date.now()

  const adapter = context.memoryAdapters.get(node.store_id)
  if (!adapter) {
    const err = new Error(`memory_read node "${node.id}": no adapter registered for store_id "${node.store_id}"`)
    context.eventBus.emit({ type: 'node:error', nodeId: node.id, error: err })
    return { stateUpdate: {} }
  }

  const mode = node.retrieval_mode ?? 'key_value'
  let result: unknown
  let resultCount: number

  if (mode === 'semantic') {
    const queryExpr = node.query_expr ?? node.key_expr ?? ''
    const query = resolveTemplate(queryExpr, state)
    const topK = node.top_k ?? 5
    const minScore = node.min_score ?? 0.0
    const hits = await adapter.search(query, topK, minScore)
    // Filter out any results below minScore (adapter may include them at score 0)
    const filtered = hits.filter(h => h.score >= minScore)
    result = filtered
    resultCount = filtered.length
  } else {
    // key_value mode
    const keyExpr = node.key_expr ?? node.query_expr ?? ''
    const key = resolveTemplate(keyExpr, state)
    const value = await adapter.get(key)
    result = value
    resultCount = value !== undefined ? 1 : 0
  }

  const stateUpdate: Record<string, unknown> = { [node.output_key]: result }

  context.eventBus.emit({
    type: 'node:complete',
    nodeId: node.id,
    nodeType: node.type,
    durationMs: Date.now() - start,
    metadata: { resultCount },
  })

  return { stateUpdate }
}
