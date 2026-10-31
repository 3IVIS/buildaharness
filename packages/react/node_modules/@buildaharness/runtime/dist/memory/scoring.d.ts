import { MemoryResult } from './adapter';
export declare function applyMode(existing: unknown, value: unknown, mode: string): unknown;
export declare function scoreEntries(entries: Iterable<[string, unknown]>, query: string, topK: number, minScore: number): MemoryResult[];
