import { AssistantConfig } from './config.js';
/**
 * One table of the settings that can be pinned by an environment variable: which variable names it on each
 * surface and how a raw value becomes the config value. The CLI reads `process.env` (ASSISTANT_*), the web and
 * desktop builds read Vite's `import.meta.env` (VITE_ASSISTANT_*); both iterate this table, so a new key is one
 * entry and the two surfaces cannot disagree on how a value is read. Pure: no node:* and no DOM imports.
 */
export type EnvSurface = 'cli' | 'vite';
export interface EnvKeySpec {
    key: keyof AssistantConfig;
    /** The variable the CLI reads. Absent when the key has no CLI env var. */
    cli?: string;
    /** The build-time variable the web and desktop builds read. Absent when the key cannot be pinned there. */
    vite?: string;
    /** `vite` names a runtime variable that is not in `import.meta.env` (the desktop reads ASSISTANT_LLM_BACKEND through a Tauri command): shown next to a read-only field, never read from the build. */
    viteDisplayOnly?: boolean;
    /** Turns the raw string into the config value, or undefined to leave the key unset (after warning). `envName` is the variable's name on this surface, for warnings. */
    fromEnv(raw: string, envName: string, surface: EnvSurface): unknown;
}
/** An unrecognised value (a typo included) falls back to 'proxy', never to some other valid-looking backend. */
export declare function normalizeLlmBackend(raw: string): NonNullable<AssistantConfig['llmBackend']>;
/** Comma-separated hostname list, trimmed, empties dropped (shellNetworkAllowlist). */
export declare function parseShellNetworkAllowlist(raw: string): string[];
/**
 * Boolean variables, the same on both surfaces (decision D6): "1" or "true" is on, "0" or "false" is off, and anything
 * else (yes, True, a typo) is off with a warning. Fail-closed on purpose: a value that is not clearly "on" must never
 * switch on shell, email or the approval bypass.
 */
export declare function parseEnvBoolean(raw: string, envName: string): boolean;
export declare const ENV_KEYS: readonly EnvKeySpec[];
/** The variable that can pin `key` on `surface`, for showing next to a value or a read-only field. */
export declare function envVarFor(surface: EnvSurface): Partial<Record<keyof AssistantConfig, string>>;
/**
 * Builds the `overrides` argument for resolveConfig() from one surface's environment, only including a key whose
 * variable is actually set, so an absent variable never shadows a persisted value. "Set" differs by surface on
 * purpose: the CLI treats any defined value (even empty) as set; a Vite build defines every VITE_ var as an empty
 * string when it is unset, so there an empty value means unset.
 */
export declare function envOverridesFrom(env: Readonly<Record<string, string | undefined>>, surface: EnvSurface): Partial<AssistantConfig>;
/** Keys whose values are a fixed set of words, for the strict /config set parser (and any picker). */
export declare const ENUM_CHOICES: Partial<Record<keyof AssistantConfig, readonly string[]>>;
/** `"a" or "b"`, or `"a", "b" or "c"`. */
export declare function formatChoices(choices: readonly string[]): string;
