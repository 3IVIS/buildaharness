import type { AssistantConfig } from '@buildaharness/aielia'
import type { WriteConnection } from './write/write-config'

/**
 * /chat and /write are served from the same origin and keep their settings apart. When one of them has a model connection and the other
 * has none yet, the other starts from a copy of it (once: after that each is changed and cleared on its own). A page that already has
 * its own connection is never touched. Search key, page-reading proxy and GitHub token travel with the connection.
 */
export const CHAT_KEY = 'buildaharness.personal-assistant.config'
export const WRITE_KEY = 'aielia-write.connection'
/** Set once a copy was made, or the writer cleared Write's connection on purpose, so a cleared page does not fill itself again. */
export const SEEDED_KEY = 'aielia.settings-shared'

const BACKENDS = ['anthropic', 'openai', 'openrouter']

function readJson(key: string): Record<string, unknown> | undefined {
  try {
    const raw = localStorage.getItem(key)
    const parsed: unknown = raw ? JSON.parse(raw) : undefined
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

function seeded(): boolean {
  try { return localStorage.getItem(SEEDED_KEY) !== null } catch { return true }
}
export function markSettingsShared(): void {
  try { localStorage.setItem(SEEDED_KEY, '1') } catch { /* nothing to remember it in */ }
}

/** The model connection and search key in the chat page's saved settings, in Write's shape; undefined when the chat page has none. */
export function connectionFromChat(chat: Partial<AssistantConfig> | Record<string, unknown> | undefined): WriteConnection | undefined {
  if (!chat) return undefined
  const c = chat as Record<string, unknown>
  const backend = c.llmBackend as string | undefined
  const searchKey = text(c.braveApiKey)
  const githubToken = text(c.githubToken)
  if (backend === 'proxy') {
    const modelUrl = text(c.proxyUrl)?.replace(/\/+$/, '')
    return modelUrl ? { provider: 'proxy', apiKey: text(c.authToken) ?? '', modelUrl, searchKey, githubToken } : undefined
  }
  const apiKey = text(c.apiKey)
  if (!apiKey || (backend !== undefined && !BACKENDS.includes(backend))) return undefined
  // Behind a direct provider, the chat page's proxy address and token are for reading pages (they are the model proxy's only when the provider is 'proxy').
  const pagesUrl = c.webBackend === 'proxy' ? text(c.proxyUrl)?.replace(/\/+$/, '') : undefined
  return { provider: (backend as WriteConnection['provider'] | undefined) ?? 'anthropic', apiKey, searchKey, githubToken, ...(pagesUrl ? { pagesUrl, pagesToken: text(c.authToken) } : {}) }
}

/** Write's first start: a copy of the chat page's connection, if there is one and Write has never been set up or cleared. */
export function writeConnectionFromChat(): WriteConnection | undefined {
  if (seeded()) return undefined
  const found = connectionFromChat(readJson(CHAT_KEY))
  if (found) markSettingsShared()
  return found
}

/** The chat page's first start: a copy of Write's connection, if the chat page has no connection of its own. */
export function seedChatFromWrite(): void {
  if (seeded()) return
  const chat = readJson(CHAT_KEY)
  if (connectionFromChat(chat) || chat?.llmBackend !== undefined || chat?.apiKey !== undefined || chat?.authToken !== undefined) return
  const w = readJson(WRITE_KEY)
  const provider = w?.provider as string | undefined
  if (!w || !provider) return
  const patch: Record<string, unknown> = { ...chat, llmBackend: provider }
  if (provider === 'proxy') {
    if (!text(w.modelUrl)) return
    patch.proxyUrl = text(w.modelUrl)
    patch.authToken = text(w.apiKey) ?? ''
  } else {
    if (!text(w.apiKey)) return
    patch.apiKey = text(w.apiKey)
    // The page-reading proxy fits the chat page's single proxy address only when the model is not itself behind a proxy.
    if (text(w.pagesUrl)) {
      patch.webBackend = 'proxy'
      patch.proxyUrl = text(w.pagesUrl)
      patch.authToken = text(w.pagesToken) ?? ''
    }
  }
  // The chat page has no use for a GitHub token yet; it keeps it so the two pages stay in step.
  if (text(w.githubToken)) patch.githubToken = text(w.githubToken)
  if (text(w.searchKey) && !text(patch.braveApiKey)) patch.braveApiKey = text(w.searchKey)
  try {
    localStorage.setItem(CHAT_KEY, JSON.stringify(patch))
    markSettingsShared()
  } catch { /* storage unavailable: nothing is shared */ }
}
