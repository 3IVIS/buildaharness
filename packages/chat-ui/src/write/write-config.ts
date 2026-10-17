import { resolveConfig, type AssistantConfig } from '@buildaharness/aielia'

/**
 * What the Write page needs to reach a model and the web, and nothing more. It has its own storage and its own screen: it does not read or
 * change the settings of the /try page, so the two can be set up, changed and cleared on their own.
 */
export interface WriteConnection {
  provider: 'anthropic' | 'openai' | 'openrouter'
  apiKey: string
  /** The address of a Aielia proxy that reads web pages and searches for this page (optional; without it links stay links). */
  pagesUrl?: string
  /** The access token that proxy asks for, if it asks. */
  pagesToken?: string
  /** A Brave Search key, sent with each search and kept only in this browser (optional; without it there is no source search). */
  searchKey?: string
}

const STORAGE_KEY = 'aielia-write.connection'

const PROVIDERS = ['anthropic', 'openai', 'openrouter']

function clean(raw: unknown): WriteConnection | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const provider = PROVIDERS.includes(r.provider as string) ? (r.provider as WriteConnection['provider']) : undefined
  const apiKey = text(r.apiKey)
  if (!provider || !apiKey) return undefined
  return { provider, apiKey, pagesUrl: text(r.pagesUrl)?.replace(/\/+$/, ''), pagesToken: text(r.pagesToken), searchKey: text(r.searchKey) }
}

/** Reads the saved connection; a missing, unreadable or incomplete one is undefined. Storage failures never throw. */
export function loadConnection(): WriteConnection | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? clean(JSON.parse(raw)) : undefined
  } catch {
    return undefined
  }
}

export function saveConnection(c: WriteConnection): void {
  const cleaned = clean(c)
  if (!cleaned) return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned))
  } catch (err) {
    console.warn('localStorage is unavailable — the connection will not persist.', err)
  }
}

export function clearConnection(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // nothing stored that could be removed
  }
}

/** The assistant configuration for a connection. Build-time settings are only defaults; what the writer saved wins. */
export function toAssistantConfig(c: WriteConnection | undefined, buildDefaults: Partial<AssistantConfig>): AssistantConfig {
  const mine: Partial<AssistantConfig> = c
    ? {
        llmBackend: c.provider,
        apiKey: c.apiKey,
        ...(c.pagesUrl ? { webBackend: 'proxy' as const, proxyUrl: c.pagesUrl, authToken: c.pagesToken ?? '' } : { webBackend: 'direct' as const }),
        braveApiKey: c.searchKey,
      }
    : {}
  return resolveConfig({ ...buildDefaults, ...mine }).config
}
