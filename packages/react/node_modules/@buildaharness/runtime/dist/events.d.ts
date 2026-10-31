export type NodeStartEvent = {
    type: 'node:start';
    nodeId: string;
    nodeType: string;
};
export type NodeCompleteEvent = {
    type: 'node:complete';
    nodeId: string;
    nodeType: string;
    durationMs: number;
    tokenCount?: number;
    retryCount?: number;
    metadata?: Record<string, unknown>;
};
export type NodeErrorEvent = {
    type: 'node:error';
    nodeId: string;
    error: unknown;
};
export type TokenChunkEvent = {
    type: 'token:chunk';
    nodeId: string;
    token: string;
};
export type FlowPausedEvent = {
    type: 'flow:paused';
    nodeId: string;
    prompt: string;
    resumeSchema: object;
};
export type FlowCompleteEvent = {
    type: 'flow:complete';
    finalState: Record<string, unknown>;
};
export type FlowErrorEvent = {
    type: 'flow:error';
    error: unknown;
};
export type RuntimeEvent = NodeStartEvent | NodeCompleteEvent | NodeErrorEvent | TokenChunkEvent | FlowPausedEvent | FlowCompleteEvent | FlowErrorEvent;
type EventHandler<T extends RuntimeEvent> = (event: T) => void;
export declare class EventBus {
    private handlers;
    subscribe<TType extends RuntimeEvent['type']>(type: TType, handler: EventHandler<Extract<RuntimeEvent, {
        type: TType;
    }>>): () => void;
    emit(event: RuntimeEvent): void;
}
export {};
