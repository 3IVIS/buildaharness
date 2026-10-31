import { Edge } from './spec/schema';
type NodeLike = {
    id: string;
    type: string;
    [key: string]: unknown;
};
export declare class FlowGraph {
    private nodeMap;
    private fwd;
    private bwd;
    private order;
    private allowCycles;
    constructor(nodes: NodeLike[], edges: Edge[], opts?: {
        allowCycles?: boolean;
    });
    private _addEdge;
    private _isConnected;
    private _topoSort;
    roots(): string[];
    leaves(): string[];
    successors(nodeId: string): string[];
    predecessors(nodeId: string): string[];
    getNode(nodeId: string): NodeLike | undefined;
    topoOrder(): string[];
}
export {};
