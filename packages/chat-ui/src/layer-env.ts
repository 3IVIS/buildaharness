import { applyLayerSettings, sanitizeLayerChoices, type AssistantConfig } from '@buildaharness/aielia'

/**
 * The reasoning layers read their `AUDIT_*` flags from `process.env`, which a browser tab / Tauri webview does not have —
 * so on the browser surfaces every layer silently stayed at its default. This gives them a minimal `process.env` (only if the
 * page has no `process` at all) and writes the saved Settings choices onto it, the same way the CLI does with the real env.
 * Returns the layer ids whose flag was already set outside Settings, which the screen shows as pinned.
 */
export function applyBrowserLayerSettings(layers: AssistantConfig['layers']): Set<string> {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } }
  if (g.process === undefined) g.process = { env: {} }
  else if (g.process.env === undefined) g.process.env = {}
  return applyLayerSettings(sanitizeLayerChoices(layers), g.process.env as Record<string, string | undefined>).pinned
}
