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
