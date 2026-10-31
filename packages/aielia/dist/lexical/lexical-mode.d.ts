export declare const LEXICAL_FAMILIES: readonly ["fact-markers", "coding-fact", "injection", "enumeration", "risk", "task-cancel", "plan-mode", "batch-list", "tool-yield", "template-keywords"];
export type LexicalFamily = (typeof LEXICAL_FAMILIES)[number];
/** The families `lexicalMode: 'disabled'` (the default) switches off: all of them. */
export declare const LEXICAL_CHECK_FAMILIES: readonly LexicalFamily[];
export type LexicalMode = 'enabled' | 'disabled';
export declare const DEFAULT_LEXICAL_MODE: LexicalMode;
type EnvLike = Record<string, string | undefined>;
export declare function isLexicalFamily(v: string): v is LexicalFamily;
/** Unset/empty ⇒ default silently; an unrecognized value ⇒ default with a warning. */
export declare function resolveLexicalMode(env?: EnvLike): LexicalMode;
/** Every family currently switched off: named in OFF, or not named in ON while the mode is disabled. */
export declare function resolveLexicalOff(env?: EnvLike): ReadonlySet<LexicalFamily>;
/** True only if this family is switched on. */
export declare function lexicalActive(family: LexicalFamily, env?: EnvLike): boolean;
/**
 * The off families as a comma list, for handing to an out-of-process helper (the MCP server). Always
 * pass it, even empty: the helper reads an unset variable as "every family off" (the default) and an
 * empty one as "none off".
 */
export declare function lexicalOffEnvValue(env?: EnvLike): string;
/**
 * Hands this mode to the harness package's own lexical switch (`setHarnessLexicalMode`), so
 * `ASSISTANT_LEXICAL_MODE=enabled` turns the harness's checks back on too. Works in a browser as well
 * as in Node (it sets no environment variable), and an explicit HARNESS_LEXICAL_MODE /
 * HARNESS_LEXICAL_ON / HARNESS_LEXICAL_OFF still wins inside the harness. Called at the start of every
 * harness run.
 */
export declare function syncHarnessLexicalEnv(env?: EnvLike): void;
export {};
