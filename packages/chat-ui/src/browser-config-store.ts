import type { AssistantConfig, ConfigStore } from '@buildaharness/personal-assistant'

const STORAGE_KEY = 'buildaharness.personal-assistant.config'

/**
 * localStorage-backed ConfigStore for the plain-browser chat-ui build (Tauri desktop uses
 * tauri-config-store.ts instead, since it has a real filesystem). A single namespaced key
 * holds the whole JSON-serialized Partial<AssistantConfig>.
 *
 * Every localStorage call is guarded: private-browsing Safari (and any context where storage
 * is disabled) can throw on setItem/getItem, and this must degrade to "config doesn't persist
 * this session" rather than crash the app — the same "capability absent, not a crash"
 * convention web-tools.ts's SSRF guard and shell-tools.ts's sandboxing already follow.
 */
export class BrowserConfigStore implements ConfigStore {
  async load(): Promise<Partial<AssistantConfig>> {
    let raw: string | null
    try {
      raw = localStorage.getItem(STORAGE_KEY)
    } catch (err) {
      console.warn('localStorage is unavailable — settings will not persist this session.', err)
      return {}
    }
    if (raw === null) return {}
    try {
      return JSON.parse(raw) as Partial<AssistantConfig>
    } catch {
      console.warn(`${STORAGE_KEY} in localStorage is not valid JSON — ignoring it and falling back to defaults.`)
      return {}
    }
  }

  async save(patch: Partial<AssistantConfig>): Promise<void> {
    const existing = await this.load()
    const merged = { ...existing, ...patch }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
    } catch (err) {
      console.warn('localStorage is unavailable — this setting change will not persist.', err)
    }
  }
}
