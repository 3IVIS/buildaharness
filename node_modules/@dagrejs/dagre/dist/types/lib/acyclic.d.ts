import { Graph } from "./graph-lib";
import type { EdgeLabel, GraphLabel, NodeLabel } from "./types";
export { run, undo };
declare function run(graph: Graph<GraphLabel, NodeLabel, EdgeLabel>, oldGraph?: Graph | null): void;
declare function undo(graph: Graph<GraphLabel, NodeLabel, EdgeLabel>): void;
//# sourceMappingURL=acyclic.d.ts.map