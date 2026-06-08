export class FlowExecutionError extends Error {
  readonly nodeId: string
  readonly cause: unknown

  constructor({ nodeId, message, cause }: { nodeId: string; message: string; cause?: unknown }) {
    super(message)
    this.name = 'FlowExecutionError'
    this.nodeId = nodeId
    this.cause = cause
  }
}

export class NodeExecutionError extends FlowExecutionError {
  constructor({ nodeId, cause }: { nodeId: string; cause?: unknown }) {
    super({ nodeId, message: `Execution failed at node "${nodeId}"`, cause })
    this.name = 'NodeExecutionError'
  }
}

export class GraphCycleError extends FlowExecutionError {
  readonly cycleNodeIds: string[]

  constructor({ nodeIds }: { nodeIds: string[] }) {
    super({ nodeId: nodeIds[0] ?? 'graph', message: `Cycle detected involving nodes: ${nodeIds.join(', ')}` })
    this.name = 'GraphCycleError'
    this.cycleNodeIds = nodeIds
  }
}

export class UnknownNodeTypeError extends FlowExecutionError {
  readonly nodeType: string

  constructor({ nodeId, nodeType }: { nodeId: string; nodeType: string }) {
    super({ nodeId, message: `Unknown node type "${nodeType}" at node "${nodeId}"` })
    this.name = 'UnknownNodeTypeError'
    this.nodeType = nodeType
  }
}

export class AbortedError extends FlowExecutionError {
  constructor({ nodeId }: { nodeId: string }) {
    super({ nodeId, message: `Execution aborted at node "${nodeId}"` })
    this.name = 'AbortedError'
  }
}

export class UnknownToolError extends FlowExecutionError {
  readonly toolName: string

  constructor({ nodeId, toolName }: { nodeId: string; toolName: string }) {
    super({ nodeId, message: `Unknown tool "${toolName}" at node "${nodeId}"` })
    this.name = 'UnknownToolError'
    this.toolName = toolName
  }
}

export class HITLTimeoutError extends FlowExecutionError {
  readonly timeoutSeconds: number

  constructor({ nodeId, timeoutSeconds }: { nodeId: string; timeoutSeconds: number }) {
    super({ nodeId, message: `HITL breakpoint at node "${nodeId}" timed out after ${timeoutSeconds}s` })
    this.name = 'HITLTimeoutError'
    this.timeoutSeconds = timeoutSeconds
  }
}
