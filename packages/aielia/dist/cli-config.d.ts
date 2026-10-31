import { AssistantConfig, CONFIG_KEYS } from './config.js';
import { redactUrlCredentials } from './redact-url.js';
/**
 * Pure logic backing cli.ts's /config command family — split out so it's unit-testable in
 * isolation, the same way error-classifier.ts and node-display-names.ts are split out of
 * cli.ts for the same reason. cli.ts itself stays thin glue (readline dispatch, ConfigStore
 * I/O, rebuilding the assistant) on top of these functions.
 */
export { CONFIG_KEYS };
/** Never printed in full by formatConfigValue — /config shows these masked regardless of value. */
export declare const SECRET_CONFIG_KEYS: ReadonlySet<keyof AssistantConfig>;
/** Which env var, if any, can pin a given key — shown next to a value in /config's listing when that var is set. */
export declare const ENV_VAR_FOR_CONFIG_KEY: Partial<Record<keyof AssistantConfig, string>>;
export declare function isConfigKey(key: string): key is keyof AssistantConfig;
/**
 * Builds the `overrides` argument for resolveConfig() from process.env — only includes a key
 * when its env var is actually set, so an absent env var can never shadow a persisted config
 * value with a falsy default. Mirrors the exact env vars/parsing cli.ts read individually
 * before this module existed (ASSISTANT_ENABLE_WEB/ASSISTANT_ENABLE_SHELL must be exactly "1").
 */
export declare function envOverridesFromProcessEnv(env: NodeJS.ProcessEnv): Partial<AssistantConfig>;
export declare function findInvalidNumericSettings(config: AssistantConfig): string[];
/** Thrown by parseConfigValue on a value that doesn't fit the target key's type — cli.ts reports .message and leaves the config unchanged. */
export declare class ConfigValueParseError extends Error {
}
/** Parses a raw `/config set <key> <value>` string into the type AssistantConfig[key] expects. */
export declare function parseConfigValue(key: keyof AssistantConfig, raw: string): unknown;
/** Renders /config's full listing as a single multi-line string — cli.ts just console.logs the result. */
export declare function formatConfigListing(config: AssistantConfig, overriddenKeys: ReadonlySet<keyof AssistantConfig>): string;
export { redactUrlCredentials };
