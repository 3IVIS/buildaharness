export declare const MANIFEST_URL = "https://myaielia.com/aielia-latest.json";
export declare const RELEASES_API_URL = "https://api.github.com/repos/3IVIS/buildaharness/releases?per_page=50";
export declare const RELEASE_TAG_PREFIX = "aielia-v";
export declare const CHECK_INTERVAL_MS: number;
export interface ReleaseAsset {
    url: string;
    /** From the manifest — the trusted hash (a different origin than the binary's github.com URL). Absent on the GitHub-API fallback. */
    sha256?: string;
    size?: number;
}
export interface ReleaseInfo {
    tag: string;
    version: string;
    /** Keyed `<process.platform>-<process.arch>`, e.g. `linux-x64`, `darwin-arm64`, `win32-x64`. */
    assets: Record<string, ReleaseAsset>;
    source: 'manifest' | 'github';
}
export interface UpdateCheckCache {
    checkedAt: number;
    latestVersion?: string;
    latestTag?: string;
    /** ETag of the GitHub Releases API response, for conditional re-requests. */
    etag?: string;
}
export interface SelfUpdateOptions {
    fetchFn?: typeof fetch;
    manifestUrl?: string;
    releasesApiUrl?: string;
    /** Test-only: permit http:// manifest/asset URLs (a local mock server). Production never sets this. */
    allowInsecureHttp?: boolean;
    now?: () => number;
    /** Defaults to `~/.buildaharness/personal-assistant`. */
    dataDir?: string;
    currentVersion?: string;
    platform?: NodeJS.Platform;
    arch?: string;
    /** Path of the running binary. Defaults to `process.execPath` (which, in a SEA, is the binary itself). */
    execPath?: string;
    /** Defaults to whether `node:sea` reports a SEA. */
    isSea?: boolean;
    log?: (line: string) => void;
}
/** Numeric `major.minor.patch` comparison; a `-prerelease` suffix sorts below the same release. Returns <0, 0, >0. */
export declare function compareVersions(a: string, b: string): number;
/** Throws on anything but https:// (unless the test-only override is set) — applied to the manifest URL and every asset URL. */
export declare function assertHttps(url: string, allowInsecureHttp?: boolean): void;
/**
 * Whether the passive check may make its unsolicited outbound request at all. Off for scripted/CI
 * runs (stdin not a TTY, or `ASSISTANT_NON_INTERACTIVE_APPROVAL` set) and when opted out via
 * `ASSISTANT_UPDATE_CHECK=disabled` / `/config set updateCheck disabled`.
 */
export declare function shouldRunPassiveUpdateCheck(input: {
    updateCheck: 'enabled' | 'disabled' | undefined;
    env: NodeJS.ProcessEnv;
    stdinIsTty: boolean;
}): boolean;
/**
 * Resolves the latest release: the product-scoped manifest first, the GitHub Releases API (filtered
 * to `aielia-v*` tags, ETag-cached) as fallback. A plain GET each — no query string, no
 * identifiers, default User-Agent only. Returns `notModified` when the API answered 304 to the
 * cached ETag; the caller then keeps the cached version.
 */
export declare function fetchLatestRelease(options: SelfUpdateOptions, etag?: string): Promise<{
    release: ReleaseInfo;
    etag?: string;
} | {
    notModified: true;
}>;
export interface UpdateCheckResult {
    latestVersion: string;
    latestTag?: string;
    updateAvailable: boolean;
}
/**
 * The passive check: 24h-throttled via `<dataDir>/update-check.json`. Never throws — any failure
 * (offline, malformed manifest, …) resolves to `null`, since an unsolicited background check must
 * never disturb a session. Callers are responsible for gating it with `shouldRunPassiveUpdateCheck`
 * first and for not awaiting it before the prompt renders.
 */
export declare function checkForUpdate(options?: SelfUpdateOptions): Promise<UpdateCheckResult | null>;
/** One-line notice; the instruction branches on how this copy was installed. */
export declare function updateAvailableNotice(latestVersion: string, currentVersion: string, isSea: boolean): string;
/** `isSea` the way the rest of the CLI decides it — false under npm/tsx, where nothing can be self-replaced. */
export declare function isRunningAsSea(): boolean;
/** Removes leftovers of a previous update (the Windows `.old` rename-aside copy, an interrupted temp download). Never throws. */
export declare function cleanupStaleUpdateFiles(execPath?: string): void;
/**
 * Replaces the binary at `execPath` with the already-verified file at `newFile` (same directory).
 * Unix: `rename` over the running binary — POSIX lets a still-open inode be replaced. Windows can't
 * overwrite a running exe, so the current one is renamed aside to `.old` first (cleaned up on the
 * next launch by `cleanupStaleUpdateFiles`), rolling back if the second rename fails.
 */
export declare function replaceBinary(execPath: string, newFile: string, platform?: NodeJS.Platform): void;
/**
 * `aielia update [--dry-run]`. Returns the process exit code (0 = up to date / updated / dry-run
 * reported; 1 = refused or failed) and reports through `options.log`. Always does a fresh check —
 * never the throttled cache — and works regardless of the `updateCheck` opt-out.
 */
export declare function runUpdateCommand(input?: {
    dryRun?: boolean;
} & SelfUpdateOptions): Promise<number>;
