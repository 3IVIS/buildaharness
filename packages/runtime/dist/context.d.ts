import { ILLMClient } from './llm-client';
import { FlowState } from './state';
import { EventBus } from './events';
import { ToolDef, ToolRegistry } from './tools/registry';
import { MemoryAdapter } from './memory/adapter';
export type { ToolDef };
export { ToolRegistry };
export interface RetryConfig {
    maxRetries: number;
    retryOn: string[];
    delayBaseMs: number;
}
export declare const DEFAULT_RETRY_CONFIG: RetryConfig;
export type FlowFunction = (state: Record<string, unknown>) => Record<string, unknown>;
export type FunctionRegistry = Map<string, FlowFunction>;
export type { MemoryAdapter } from './memory/adapter';
export interface HarnessMeta {
    process_concept_id: string | null;
}
export interface ExecutionContext {
    readonly llmClient: ILLMClient;
    readonly toolRegistry: ToolRegistry;
    readonly memoryAdapters: Map<string, MemoryAdapter>;
    readonly eventBus: EventBus;
    readonly signal: AbortSignal;
    readonly functions: FunctionRegistry;
    readonly hitlResolvers: Map<string, (payload: unknown) => void>;
    readonly branchResults: Map<string, FlowState[]>;
    readonly retryConfig: RetryConfig;
    readonly agents: Map<string, unknown>;
    readonly subgraphRegistry: Map<string, unknown>;
    readonly hitlPersistStore: MemoryAdapter;
    readonly harnessMeta: HarnessMeta;
    /** Nesting level of the subgraph currently executing (0/absent at the top level); guards flow_ref cycles. */
    readonly subgraphDepth?: number;
}
export declare function createExecutionContext(opts: {
    llmClient: ILLMClient;
    toolRegistry?: ToolRegistry;
    memoryAdapters?: Map<string, MemoryAdapter>;
    eventBus?: EventBus;
    abortController?: AbortController;
    functions?: FunctionRegistry;
    retryConfig?: Partial<RetryConfig>;
    agents?: Map<string, unknown>;
    subgraphRegistry?: Map<string, unknown>;
    hitlPersistStore?: MemoryAdapter;
    harnessMeta?: Partial<HarnessMeta>;
}): ExecutionContext & {
    abortController: AbortController;
};
