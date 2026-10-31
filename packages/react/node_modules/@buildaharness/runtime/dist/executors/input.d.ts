import { Node } from '../spec/schema';
import { FlowState } from '../state';
import { ExecutionContext } from '../context';
import { ExecutorOutput } from './index';
export declare function inputExecutor(node: Node, state: FlowState, context: ExecutionContext): Promise<ExecutorOutput>;
