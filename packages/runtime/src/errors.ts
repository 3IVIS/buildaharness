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
