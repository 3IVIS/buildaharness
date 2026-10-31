import { MemoryAdapter } from '@buildaharness/runtime';
/** One list to replace. `value: null` removes the list (distinct from an empty list, so an undo can restore "absent"). */
export interface FactChange {
    key: string;
    value: unknown[] | null;
}
/** Thrown by `apply()` when `expectedVersion` is not the repository's current version. */
export declare class VersionConflictError extends Error {
    readonly expected: number;
    readonly actual: number;
    constructor(expected: number, actual: number);
}
export interface FactQuery<T> {
    /** Keep only rows for which this returns true (status, tier, attribute key and project are all row predicates). */
    where?: (row: T) => boolean;
}
export interface FactRepository {
    /** Monotonic counter, bumped by every successful `apply`/`put`/`remove`/`appendEvents`. */
    version(): number;
    /** The whole list stored under `key`, `[]` when absent. */
    list<T>(key: string, query?: FactQuery<T>): Promise<T[]>;
    /** The first row under `key` whose id (from `idOf`) equals `id`. */
    get<T>(key: string, id: string, idOf: (row: T) => string): Promise<T | undefined>;
    /** Replace several lists as one commit: all land or none do. Throws `VersionConflictError` if `expectedVersion` is stale. */
    apply(changes: FactChange[], expectedVersion?: number): Promise<number>;
    /** Single-list shorthands for `apply`. */
    put(key: string, value: unknown[]): Promise<void>;
    remove(key: string): Promise<void>;
    /** Append to an ordered event list in one step, then let `trim` bound it. Order of appends is preserved. */
    appendEvents<T>(key: string, events: T[], trim?: (all: T[]) => T[]): Promise<T[]>;
}
/** Today's behaviour: each list lives under its own `MemoryAdapter` key. The version is per instance (one process). */
export declare class KeyValueFactRepository implements FactRepository {
    private readonly store;
    private ver;
    constructor(store: MemoryAdapter);
    version(): number;
    list<T>(key: string, query?: FactQuery<T>): Promise<T[]>;
    get<T>(key: string, id: string, idOf: (row: T) => string): Promise<T | undefined>;
    apply(changes: FactChange[], expectedVersion?: number): Promise<number>;
    put(key: string, value: unknown[]): Promise<void>;
    remove(key: string): Promise<void>;
    appendEvents<T>(key: string, events: T[], trim?: (all: T[]) => T[]): Promise<T[]>;
}
