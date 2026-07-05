/**
 * Best-effort request that the browser exempt this origin's storage from
 * automatic eviction under disk pressure (StorageManager.persist()). This does
 * NOT survive the user manually clearing site data, and support/behavior
 * varies by browser (Chrome grants liberally for engaged origins; Firefox
 * prompts; Safari's support is limited) — it only reduces the odds of silent
 * background eviction, it's not a persistence guarantee.
 *
 * Safe to call from Node/tests: resolves to false immediately when
 * `navigator.storage` isn't available, never throws.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    const storage = (globalThis as { navigator?: { storage?: StorageManager } }).navigator?.storage
    if (!storage?.persist) return false
    if (storage.persisted && (await storage.persisted())) return true
    return await storage.persist()
  } catch {
    return false
  }
}
