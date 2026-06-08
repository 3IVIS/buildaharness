import { assertFlowSpec } from '@itsharness/canvas'
import type { FlowSpec, Node } from '@itsharness/canvas'
import { FlowGraph } from './graph'
import { FlowState } from './state'
import type { ExecutionContext } from './context'
import { getExecutor } from './executors/index'
import type { ExecutorOutput } from './executors/index'
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

      // Validate executor exists before attempting to run (gives clearer error)
      if (!getExecutor(node.type)) {
        throw new UnknownNodeTypeError({ nodeId: node.id, nodeType: node.type })
      }

      const result = await this._runNodeWithRetry(node, state, context)
      state.patch(result.stateUpdate)

      if (node.type === 'parallel_fork') {
        // FlowRuntime handles the actual branching — executor just emits events
        const forkNode = node as { type: 'parallel_fork'; targets: string[] }
        const joinNodeId = await this._runBranches(forkNode.targets, state, context, graph)
        currentNodeId = joinNodeId
        // After returning from branches, immediately execute the join node
        continue
      }

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

  // ---------------------------------------------------------------------------
  // Node execution with retry + exponential backoff
  // ---------------------------------------------------------------------------

  async _runNodeWithRetry(
    node: Node,
    state: FlowState,
    context: ExecutionContext,
  ): Promise<ExecutorOutput & { retryCount: number }> {
    const executor = getExecutor(node.type)
    if (!executor) {
      throw new UnknownNodeTypeError({ nodeId: node.id, nodeType: node.type })
    }

    const { maxRetries, retryOn, delayBaseMs } = context.retryConfig
    let attempt = 0

    while (true) {
      try {
        const result = await executor(node, state, context)
        return { ...result, retryCount: attempt }
      } catch (err) {
        // Check retryability BEFORE wrapping so raw TypeError (network error) is visible
        if (attempt < maxRetries && this._shouldRetry(err, retryOn)) {
          attempt++
          const delay = delayBaseMs * Math.pow(2, attempt - 1)
          if (delay > 0) {
            await new Promise(resolve => setTimeout(resolve, delay))
          }
          continue
        }
        // Not retrying — emit error event and re-throw (wrapping if not already FlowExecutionError)
        if (err instanceof FlowExecutionError) {
          context.eventBus.emit({ type: 'node:error', nodeId: node.id, error: err })
          throw err
        }
        const wrapped = new NodeExecutionError({ nodeId: node.id, cause: err })
        context.eventBus.emit({ type: 'node:error', nodeId: node.id, error: wrapped })
        throw wrapped
      }
    }
  }

  _shouldRetry(err: unknown, retryOn: string[]): boolean {
    // Check for specific HTTP status codes in retryOn (e.g. '429')
    if (err instanceof FlowExecutionError) {
      const cause = err.cause as { status?: number } | undefined
      if (cause?.status !== undefined && retryOn.includes(String(cause.status))) return true
    }
    // Check for network errors (TypeError with no cause — browser fetch failure)
    if (err instanceof TypeError && retryOn.includes('network')) return true
    return false
  }

  // ---------------------------------------------------------------------------
  // Parallel branch execution
  // ---------------------------------------------------------------------------

  async _runBranches(
    targets: string[],
    parentState: FlowState,
    context: ExecutionContext,
    graph: FlowGraph,
  ): Promise<string> {
    // Create per-branch AbortControllers linked to the parent signal
    const branchControllers = targets.map(() => new AbortController())

    // Link parent abort signal to all branch controllers
    if (context.signal.addEventListener) {
      context.signal.addEventListener('abort', () => {
        for (const ctrl of branchControllers) ctrl.abort()
      })
    }

    const branchPromises = targets.map((targetId, idx) => {
      // Each branch gets an independent snapshot of parent state
      const branchState = parentState.snapshot()
      const branchController = branchControllers[idx]

      // Build a branch context that uses the branch's own abort signal
      const branchContext: ExecutionContext = {
        ...context,
        signal: branchController.signal,
      }

      return this._runBranch(targetId, branchState, branchContext, graph)
    })

    let results: { joinNodeId: string; finalState: FlowState }[]
    try {
      results = await Promise.all(
        branchPromises.map((p, idx) =>
          p.catch(err => {
            // Abort all other branches when one fails
            for (let i = 0; i < branchControllers.length; i++) {
              if (i !== idx) branchControllers[i].abort()
            }
            throw err
          })
        )
      )
    } catch (err) {
      throw err
    }

    // All branches converge at the same join node
    const resolvedJoinNodeId = results[0].joinNodeId

    // Store branch final states in context for the join executor to read
    const branchStates = results.map(r => r.finalState)
    context.branchResults.set(resolvedJoinNodeId, branchStates)

    return resolvedJoinNodeId
  }

  async _runBranch(
    startNodeId: string,
    state: FlowState,
    context: ExecutionContext,
    graph: FlowGraph,
  ): Promise<{ finalState: FlowState; joinNodeId: string }> {
    let currentNodeId: string | null = startNodeId

    while (currentNodeId !== null) {
      if (context.signal.aborted) {
        throw new AbortedError({ nodeId: currentNodeId })
      }

      const node = graph.getNode(currentNodeId)
      if (!node) {
        throw new FlowExecutionError({
          nodeId: currentNodeId,
          message: `Node "${currentNodeId}" not found in graph`,
        })
      }

      // Stop when we hit a join node — do NOT execute it; let the parent loop handle it
      if (node.type === 'parallel_join') {
        return { finalState: state, joinNodeId: currentNodeId }
      }

      if (!getExecutor(node.type)) {
        throw new UnknownNodeTypeError({ nodeId: node.id, nodeType: node.type })
      }

      const result = await this._runNodeWithRetry(node, state, context)
      state.patch(result.stateUpdate)

      // Handle nested parallel forks inside a branch
      if (node.type === 'parallel_fork') {
        const forkNode = node as { type: 'parallel_fork'; targets: string[] }
        const nestedJoinId = await this._runBranches(forkNode.targets, state, context, graph)
        currentNodeId = nestedJoinId
        continue
      }

      // Determine next node
      if (result.routeToNodeId != null) {
        currentNodeId = result.routeToNodeId
      } else {
        const successors = graph.successors(currentNodeId)
        currentNodeId = successors.length > 0 ? successors[0] : null
      }
    }

    // Branch terminated without reaching a parallel_join — structural error
    throw new FlowExecutionError({
      nodeId: startNodeId,
      message: `Branch starting at "${startNodeId}" terminated without reaching a parallel_join node`,
    })
  }
}
