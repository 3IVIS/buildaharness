/** `~/.buildaharness/personal-assistant/sea-cache/<version>` — same data dir as cli.ts's `defaultDataDir`. */
export declare function seaCacheDir(version: string, home?: string): string;
/**
 * Writes `read()`'s bytes to `<dir>/<fileName>` unless that exact path already exists, and returns
 * the path. Version-gated by construction: `dir` embeds the CLI version, so a new release never
 * reuses a stale extraction. Written via a temp file + rename so a crash or a concurrent second
 * launch can never observe (and then import) a half-written file.
 */
export declare function extractAssetOnce(dir: string, fileName: string, read: () => string | ArrayBuffer): string;
