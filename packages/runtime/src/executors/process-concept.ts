import type { Node } from '../spec/schema'
import type { FlowState } from '../state'
import type { ExecutionContext } from '../context'
import type { ExecutorOutput } from './index'
import { FlowExecutionError } from '../errors'

export async function processConceptExecutor(
  node: Node,
  _state: FlowState,
  context: ExecutionContext,
): Promise<ExecutorOutput> {
  context.eventBus.emit({ type: 'node:start', nodeId: node.id, nodeType: node.type })

  const harnessConfig = (node as Record<string, unknown>).harness_config as
    | Record<string, unknown>
    | undefined

  const conceptId = harnessConfig?.concept_id as string | undefined
  if (!conceptId) {
    throw new FlowExecutionError({
      nodeId: node.id,
      message: 'process_concept node missing required harness_config.concept_id (INV-PC-04)',
    })
  }

  // Store concept ID in harnessMeta for HarnessRuntime to pick up at startup
  ;(context.harnessMeta as { process_concept_id: string | null }).process_concept_id = conceptId

  context.eventBus.emit({ type: 'node:complete', nodeId: node.id, nodeType: node.type, durationMs: 0 })
  return { stateUpdate: {} }
}
