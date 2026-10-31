import { FlowGraph } from './graph';
import { FlowState } from './state';
import { ExecutionContext } from './context';
import { ExecutorOutput } from './executors/index';
export declare class FlowRuntime {
    _activeContext: ExecutionContext | null;
    /** Initialize memory stores from FlowSpec.memory_stores, skipping pre-registered adapters. */
    private _initMemoryStores;
    resume(nodeId: string, payload: unknown): void;
    execute(flowSpec: unknown, triggerData: Record<string, unknown>, context: ExecutionContext): Promise<FlowState>;
    _runNodeWithRetry(node: {
        id: string;
        type: string;
        [key: string]: unknown;
    }, state: FlowState, context: ExecutionContext): Promise<ExecutorOutput & {
        retryCount: number;
    }>;
    _shouldRetry(err: unknown, retryOn: string[]): boolean;
    _runBranches(targets: string[], parentState: FlowState, context: ExecutionContext, graph: FlowGraph): Promise<string>;
    _runBranch(startNodeId: string, state: FlowState, context: ExecutionContext, graph: FlowGraph): Promise<{
        finalState: FlowState;
        joinNodeId: string;
    }>;
}
