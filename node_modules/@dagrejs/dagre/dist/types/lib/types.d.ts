import { Graph as GraphLibGraph } from '@dagrejs/graphlib';
export type Graph<G = any, N = any, E = any> = GraphLibGraph<G, N, E>;
export type { Edge as GraphEdge } from '@dagrejs/graphlib';
export interface Point {
    x: number;
    y: number;
}
export interface NodeLabel {
    width: number;
    height: number;
    x?: number;
    y?: number;
    rank?: number;
    order?: number;
    e?: number;
    dummy?: 'edge' | 'border' | 'edge-label' | 'edge-proxy' | 'selfedge' | 'root';
    borderType?: 'borderLeft' | 'borderRight';
    borderTop?: string;
    borderBottom?: string;
    borderLeft?: string[];
    borderRight?: string[];
    minRank?: number;
    maxRank?: number;
    label?: string;
    labelpos?: 'l' | 'c' | 'r';
    class?: string;
    padding?: number;
    paddingX?: number;
    paddingY?: number;
    rx?: number;
    ry?: number;
    shape?: string;
    edgeLabel?: EdgeLabel;
    edgeObj?: Edge;
    /**
     * Optional direction for clusters/subgraphs. If set, overrides the global graph direction for this cluster.
     */
    rankdir?: 'TB' | 'BT' | 'LR' | 'RL';
    /**
     * Optional rank separation override for this cluster/subgraph.
     */
    ranksep?: number;
    /**
     * Optional node separation override for this cluster/subgraph.
     */
    nodesep?: number;
    /**
     * Optional alignment override for this cluster/subgraph.
     */
    align?: 'UL' | 'UR' | 'DL' | 'DR';
    [key: string]: unknown;
}
export interface EdgeLabel {
    points?: Point[];
    width?: number;
    height?: number;
    minlen?: number;
    weight?: number;
    labelpos?: 'l' | 'c' | 'r';
    labeloffset?: number;
    labelRank?: number;
    x?: number;
    y?: number;
    e?: number;
    reversed?: boolean;
    forwardName?: string;
    selfEdge?: boolean;
    nestingEdge?: boolean;
    cutvalue?: number;
    lim?: number;
    low?: number;
    parent?: string;
    edgeLabel?: EdgeLabel;
    edgeObj?: Edge;
    [key: string]: unknown;
}
export interface GraphLabel {
    width?: number;
    height?: number;
    compound?: boolean;
    rankdir?: 'TB' | 'BT' | 'LR' | 'RL';
    align?: 'UL' | 'UR' | 'DL' | 'DR';
    nodesep?: number;
    edgesep?: number;
    ranksep?: number;
    marginx?: number;
    marginy?: number;
    acyclicer?: 'greedy';
    ranker?: 'network-simplex' | 'tight-tree' | 'longest-path';
    rankalign?: 'top' | 'center' | 'bottom';
    nestingRoot?: string;
    nodeRankFactor?: number;
    dummyChains?: string[];
    [key: string]: unknown;
}
export interface NodeConfig {
    width?: number;
    height?: number;
}
export interface EdgeConfig {
    minlen?: number;
    weight?: number;
    width?: number;
    height?: number;
    labelpos?: 'l' | 'c' | 'r';
    labeloffset?: number;
}
export interface OrderOptions {
    customOrder?: (graph: Graph<GraphLabel, NodeLabel, EdgeLabel>, order: (graph: Graph<GraphLabel, NodeLabel, EdgeLabel>, opts?: LayoutOptions, oldNodes?: NodeCollection) => void) => void;
    disableOptimalOrderHeuristic?: boolean;
    constraints?: OrderConstraint[];
}
export interface LayoutConfig extends OrderOptions {
    useDynamic?: boolean;
    corePath?: string[];
}
export interface OrderConstraint {
    left: string;
    right: string;
}
export type LayoutOptions = GraphLabel & NodeConfig & EdgeConfig & LayoutConfig;
export type RankerFunction = (graph: Graph<GraphLabel, NodeLabel, EdgeLabel>) => void;
export type WeightFunction = (edge: Edge) => number;
export type TimingFunction = (name: string, fn: () => void) => void;
export type WeightMap = {
    [key: string]: number;
};
export interface PartitionResult<T> {
    lhs: T[];
    rhs: T[];
}
export interface ListEntry<T> {
    value: T;
    prev?: ListEntry<T>;
    next?: ListEntry<T>;
}
export interface Edge {
    v: string;
    w: string;
    name?: string;
}
export type NodeCollection = Record<string, NodeLabel> | null;
//# sourceMappingURL=types.d.ts.map