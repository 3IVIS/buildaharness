import { envOverridesFrom, envVarFor, normalizeLlmBackend, type AssistantConfig } from '@buildaharness/aielia'

/**
 * Browser-side companion to aielia's cli-config.ts — same idea (env-var-name map
 * + an overrides builder for resolveConfig), but for Vite's build-time VITE_ASSISTANT_* vars
 * instead of the CLI's process.env ones. Used by both App.tsx (T7, to compute overrides) and
 * SettingsScreen.tsx (to show which fields are build-time-pinned and therefore read-only).
 */

/** Which VITE_* build-time var, if any, can pin a given key — shown next to a read-only field in SettingsScreen. */
export const ENV_VAR_FOR_CONFIG_KEY: Partial<Record<keyof AssistantConfig, string>> = envVarFor('vite')

/**
 * Builds the `overrides` argument for resolveConfig() from Vite's import.meta.env. The key table and the way each
 * value is read are shared with the CLI (config-keys.ts); a key is only included when its build-time var is set (non-empty).
 */
export function envOverridesFromImportMetaEnv(env: ImportMetaEnv): Partial<AssistantConfig> {
  return envOverridesFrom(env as unknown as Record<string, string | undefined>, 'vite')
}

/**
 * Desktop only: turns the raw ASSISTANT_LLM_BACKEND value (App.tsx fetches it through the
 * get_env_llm_backend Tauri command) into a config override, with the same rule as the aielia
 * CLI's envOverridesFromProcessEnv — unset means no override; a recognized value is used as is;
 * anything else (a typo included) falls back to 'proxy' rather than some other valid backend.
 */
export function llmBackendFromEnvValue(raw: string | null | undefined): Partial<AssistantConfig> {
  if (raw === null || raw === undefined) return {}
  return { llmBackend: normalizeLlmBackend(raw) }
}

/**
 * Splits the build-time values into pins and defaults. A key named in VITE_ASSISTANT_DEFAULTS_ONLY (comma separated) is a default that a
 * visitor's saved setting replaces and Settings can edit; every other build value stays a pin (read-only, wins over saved config), as before.
 * The hosted /chat build uses it for its proxy address and web settings, so a visitor can point the page at a proxy of their own.
 */
export function splitBuildDefaults(env: ImportMetaEnv, all: Partial<AssistantConfig>): { pins: Partial<AssistantConfig>; defaults: Partial<AssistantConfig> } {
  const soft = new Set(String(env.VITE_ASSISTANT_DEFAULTS_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean))
  const pins: Record<string, unknown> = {}
  const defaults: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(all)) (soft.has(k) ? defaults : pins)[k] = v
  return { pins: pins as Partial<AssistantConfig>, defaults: defaults as Partial<AssistantConfig> }
}
