import { Node } from '../spec/schema';
import { FlowState } from '../state';
import { ExecutionContext } from '../context';
import { ExecutorOutput } from './index';
export declare function parallelForkExecutor(node: Node, _state: FlowState, context: ExecutionContext): Promise<ExecutorOutput>;
