import { MemoryAdapter, MemoryResult } from './adapter';
import { FsBackend } from './fs-backend';
export interface FileSystemAdapterOptions {
    backend: FsBackend;
    /** Directory the namespace lives under, e.g. an app's local data dir. */
    baseDir: string;
    namespace?: string;
}
/**
 * MemoryAdapter backed by real files — one JSON file per key under
 * `<baseDir>/<namespace>/`, keyed by a filesystem-safe slug of the key (the
 * original key is stored inside the file so `search()` can still report it
 * correctly even if two keys sanitize to the same slug — extremely unlikely
 * given this adapter's key space, but cheap to guard against).
 *
 * File I/O goes through an injected FsBackend rather than a direct dependency
 * on any specific filesystem API, so the same class serves both the Tauri
 * desktop app (@tauri-apps/plugin-fs) and the CLI (node:fs/promises) without
 * this package depending on either.
 */
export declare class FileSystemAdapter implements MemoryAdapter {
    private readonly backend;
    private readonly dir;
    private dirEnsured;
    constructor(opts: FileSystemAdapterOptions);
    private ensureDir;
    private path;
    private collisionPath;
    private readFile;
    /**
     * Two different keys can sanitize to the same slug (e.g. "a:b" and "a_b"); the slug file belongs to
     * whichever wrote it first, and a later colliding key is stored under a hash-suffixed name instead of
     * silently reading or overwriting the other key's entry.
     */
    private locate;
    get(key: string): Promise<unknown>;
    private writeQueue;
    set(key: string, value: unknown, mode?: string): Promise<void>;
    search(query: string, topK?: number, minScore?: number): Promise<MemoryResult[]>;
    delete(key: string): Promise<void>;
}
