import { Node } from '../spec/schema';
import { FlowState } from '../state';
import { ExecutionContext } from '../context';
export interface ExecutorOutput {
    stateUpdate: Record<string, unknown>;
    routeToNodeId?: string;
    tokenCount?: number;
}
export type ExecutorFn = (node: Node, state: FlowState, context: ExecutionContext) => Promise<ExecutorOutput>;
export declare function _stubExecutor(node: Node, _state: FlowState, context: ExecutionContext): Promise<ExecutorOutput>;
export declare function getExecutor(nodeType: string): ExecutorFn | undefined;
export declare function registerExecutor(nodeType: string, fn: ExecutorFn): void;
export declare function unregisterExecutor(nodeType: string): void;
