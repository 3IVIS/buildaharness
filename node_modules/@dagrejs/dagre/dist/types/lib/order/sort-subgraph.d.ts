import type { Graph, NodeCollection } from '../types';
interface SubgraphResult {
    vs: string[];
    barycenter?: number;
    weight?: number;
}
export default function sortSubgraph(graph: Graph, v: string, constraintGraph: Graph, oldNodes?: NodeCollection | boolean, biasRight?: boolean): SubgraphResult & {
    result: SubgraphResult;
    usedBias: boolean;
};
export {};
//# sourceMappingURL=sort-subgraph.d.ts.map