import { AssistantConfig, ConfigStore } from './config.js';
/**
 * JSON-file-backed ConfigStore for the CLI, at a single `config.json` path (typically
 * `<dataDir>/config.json`). Deliberately not exported from this package's index — only cli.ts
 * imports it, same reasoning as node-fs-backend.ts — so a browser build never pulls in
 * node:fs/promises.
 *
 * save() merges the patch onto whatever's already persisted (never a blind overwrite of
 * unrelated keys) and writes through a temp-file-then-rename so a crash mid-write can never
 * leave a half-written config.json behind — the same failure mode file-tools.ts's
 * .pending-actions staging already avoids the same way. Setting a key to `undefined` in a
 * patch removes it from the persisted file (JSON.stringify drops undefined-valued
 * properties), which is what /config reset relies on.
 *
 * Concurrent save() calls on the same instance are serialized through an internal queue —
 * cli.ts's readline 'line' handler doesn't wait for one command to finish before dispatching
 * the next (e.g. piped stdin with two /config set lines back to back), so without this a
 * second save()'s load-modify-write could race the first's: reading stale state before the
 * first's write lands and silently clobbering it, or (with a timestamp-only temp filename)
 * colliding on the exact same temp path within the same millisecond.
 */
export declare class NodeConfigStore implements ConfigStore {
    private readonly path;
    private queue;
    constructor(path: string);
    load(): Promise<Partial<AssistantConfig>>;
    save(patch: Partial<AssistantConfig>): Promise<void>;
    private writePatch;
}
