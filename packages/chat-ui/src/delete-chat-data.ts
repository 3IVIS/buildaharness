/** Names of the browser databases the chat keeps (memory, checkpoints, experience). Write's articles live in a different database and are not touched. */
export const CHAT_DATABASES = [
  'buildaharness-memory-personal-assistant',
  'buildaharness-memory-personal-assistant-checkpoints',
  'buildaharness-experience-personal-assistant',
]

function deleteDatabase(factory: IDBFactory, name: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => resolve()
    try {
      const req = factory.deleteDatabase(name)
      req.onsuccess = done
      req.onerror = done
      req.onblocked = () => setTimeout(done, timeoutMs)
      setTimeout(done, timeoutMs)
    } catch {
      resolve()
    }
  })
}

/** Removes everything the chat keeps in this browser: its databases and the listed localStorage keys. Never throws; storage that is unavailable has nothing to remove. */
export async function deleteChatData(opts: { localKeys: string[]; storage?: Pick<Storage, 'removeItem'>; factory?: IDBFactory; timeoutMs?: number }): Promise<void> {
  const factory = opts.factory ?? (typeof indexedDB !== 'undefined' ? indexedDB : undefined)
  if (factory) await Promise.all(CHAT_DATABASES.map((n) => deleteDatabase(factory, n, opts.timeoutMs ?? 2000)))
  for (const key of opts.localKeys) {
    try { (opts.storage ?? localStorage).removeItem(key) } catch { /* nothing was stored */ }
  }
}
