export declare const MCP_SERVER_FILE_NAME = "file-tools-mcp-server.mjs";
/**
 * The lexical pattern files file-tools-mcp-server.mjs reads at startup via
 * `join(__dirname, 'lexical/patterns/<name>')` — they have to sit beside the extracted server,
 * so they are embedded as SEA assets (under this same relative key) and extracted with it.
 */
export declare const MCP_SERVER_PATTERN_FILES: readonly ["injection-patterns.json", "fact-markers.json", "risk-patterns.json"];
export interface SeaModule {
    isSea(): boolean;
    getRawAsset(key: string): ArrayBuffer;
}
/** `node:sea` if this process is a Node single executable application, else null. Never throws. */
export declare function loadSea(): SeaModule | null;
/**
 * Absolute on-disk path to file-tools-mcp-server.mjs, which the claude-cli backend hands to the
 * separate `claude` binary to spawn as a `node <path>` MCP subprocess.
 *
 * - Inside a SEA binary, `import.meta.url` is not a real file location, so the embedded asset is
 *   extracted once (version-gated, see sea-cache.ts) and that path returned.
 * - Otherwise (npm install, tsx), it is the file sitting next to this module, as before.
 *
 * `seaOverride` and `home` exist for tests; production callers pass nothing.
 */
export declare function resolveMcpServerPath(seaOverride?: SeaModule | null, home?: string): string;
