import type { AssistantConfig } from '@buildaharness/personal-assistant'

/**
 * Browser-side companion to personal-assistant's cli-config.ts — same idea (env-var-name map
 * + an overrides builder for resolveConfig), but for Vite's build-time VITE_ASSISTANT_* vars
 * instead of the CLI's process.env ones. Used by both App.tsx (T7, to compute overrides) and
 * SettingsScreen.tsx (to show which fields are build-time-pinned and therefore read-only).
 */

/** Which VITE_* build-time var, if any, can pin a given key — shown next to a read-only field in SettingsScreen. */
export const ENV_VAR_FOR_CONFIG_KEY: Partial<Record<keyof AssistantConfig, string>> = {
  proxyUrl: 'VITE_ASSISTANT_PROXY_URL',
  authToken: 'VITE_ASSISTANT_PROXY_TOKEN',
  model: 'VITE_ASSISTANT_MODEL',
}

/**
 * Builds the `overrides` argument for resolveConfig() from Vite's import.meta.env — only
 * includes a key when its build-time var is actually set (non-empty), matching App.tsx's
 * existing `?? default` / `|| undefined` fallbacks exactly, so this is a behavior-preserving
 * read of the same three vars it already read individually.
 */
export function envOverridesFromImportMetaEnv(env: ImportMetaEnv): Partial<AssistantConfig> {
  const overrides: Partial<AssistantConfig> = {}
  if (env.VITE_ASSISTANT_PROXY_URL) overrides.proxyUrl = env.VITE_ASSISTANT_PROXY_URL
  if (env.VITE_ASSISTANT_PROXY_TOKEN) overrides.authToken = env.VITE_ASSISTANT_PROXY_TOKEN
  if (env.VITE_ASSISTANT_MODEL) overrides.model = env.VITE_ASSISTANT_MODEL
  return overrides
}
