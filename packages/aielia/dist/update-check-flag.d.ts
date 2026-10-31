/**
 * Pure logic backing the passive update check's opt-out (`ASSISTANT_UPDATE_CHECK` /
 * `/config set updateCheck`) — same shape as tui-mode-flag.ts/one-loop-flag.ts. 'enabled' is the
 * default; 'disabled' silences only the *passive* background check — the explicit
 * `aielia update` command still works either way.
 */
export type UpdateCheckMode = 'enabled' | 'disabled';
export declare const DEFAULT_UPDATE_CHECK_MODE: UpdateCheckMode;
/** An unset/empty value falls back silently; an unrecognized one falls back with a warning naming `varName`. */
export declare function normalizeUpdateCheckMode(raw: string | undefined, varName?: string): UpdateCheckMode;
export declare function resolveUpdateCheckMode(env: NodeJS.ProcessEnv): UpdateCheckMode;
