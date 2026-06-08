export type NodeStartEvent = { type: 'node:start'; nodeId: string; nodeType: string }
export type NodeCompleteEvent = { type: 'node:complete'; nodeId: string; nodeType: string; durationMs: number; tokenCount?: number; retryCount?: number; metadata?: Record<string, unknown> }
export type NodeErrorEvent = { type: 'node:error'; nodeId: string; error: unknown }
export type TokenChunkEvent = { type: 'token:chunk'; nodeId: string; token: string }
export type FlowPausedEvent = { type: 'flow:paused'; nodeId: string; prompt: string; resumeSchema: object }
export type FlowCompleteEvent = { type: 'flow:complete'; finalState: Record<string, unknown> }
export type FlowErrorEvent = { type: 'flow:error'; error: unknown }

export type RuntimeEvent =
  | NodeStartEvent
  | NodeCompleteEvent
  | NodeErrorEvent
  | TokenChunkEvent
  | FlowPausedEvent
  | FlowCompleteEvent
  | FlowErrorEvent

type EventHandler<T extends RuntimeEvent> = (event: T) => void

export class EventBus {
  private handlers = new Map<string, Set<EventHandler<RuntimeEvent>>>()

  subscribe<T extends RuntimeEvent>(type: T['type'], handler: EventHandler<T>): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set())
    this.handlers.get(type)!.add(handler as EventHandler<RuntimeEvent>)
    return () => this.handlers.get(type)?.delete(handler as EventHandler<RuntimeEvent>)
  }

  emit(event: RuntimeEvent): void {
    this.handlers.get(event.type)?.forEach((h) => h(event))
  }
}
