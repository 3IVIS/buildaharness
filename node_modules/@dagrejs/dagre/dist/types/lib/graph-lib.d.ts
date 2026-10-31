import { alg, Graph as GraphLibGraph } from "@dagrejs/graphlib";
export type Graph<G = any, N = any, E = any> = GraphLibGraph<G, N, E>;
export declare const Graph: new <G = any, N = any, E = any>(opts?: any) => GraphLibGraph<G, N, E>;
export type { Edge } from "@dagrejs/graphlib";
export { alg };
//# sourceMappingURL=graph-lib.d.ts.map