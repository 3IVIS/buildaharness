import type { Graph, NodeCollection } from '../types';
import { ResolvedEntry } from "./resolve-conflicts";
interface SortEntry {
    vs: string[];
    i: number;
    barycenter?: number;
    weight?: number;
}
interface SortResult {
    vs: string[];
    barycenter?: number;
    weight?: number;
}
export default function sort(entries: SortEntry[], reversedPairs?: Record<string, ResolvedEntry> | boolean, oldNodes?: NodeCollection, graph?: Graph | null, biasRight?: boolean): SortResult;
export {};
//# sourceMappingURL=sort.d.ts.map