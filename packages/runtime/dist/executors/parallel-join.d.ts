import { Node } from '../spec/schema';
import { FlowState } from '../state';
import { ExecutionContext } from '../context';
import { ExecutorOutput } from './index';
export declare function parallelJoinExecutor(node: Node, _state: FlowState, context: ExecutionContext): Promise<ExecutorOutput>;
