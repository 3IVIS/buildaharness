import { resolveConfig, type AssistantConfig } from '@buildaharness/aielia'

/**
 * What the Write page needs to reach a model and the web, and nothing more. It has its own storage and its own screen: it does not read or
 * change the settings of the /try page, so the two can be set up, changed and cleared on their own.
 */
export interface WriteConnection {
  provider: 'anthropic' | 'openai' | 'openrouter' | 'proxy'
  /** The provider key; for a self-hosted model proxy, the access token that proxy asks for (may be empty). */
  apiKey: string
  /** Only for provider 'proxy': the address of a proxy you run that answers model calls (a self-hosted @buildaharness/proxy, or a bridge that speaks the same /llm/chat). */
  modelUrl?: string
  /** The address of a Aielia proxy that reads web pages and searches for this page (optional; without it links stay links). */
  pagesUrl?: string
  /** The access token that proxy asks for, if it asks. */
  pagesToken?: string
  /** A Brave Search key, sent with each search and kept only in this browser (optional; without it there is no source search). */
  searchKey?: string
}

const STORAGE_KEY = 'aielia-write.connection'

const PROVIDERS = ['anthropic', 'openai', 'openrouter', 'proxy']

function clean(raw: unknown): WriteConnection | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const provider = PROVIDERS.includes(r.provider as string) ? (r.provider as WriteConnection['provider']) : undefined
  const apiKey = text(r.apiKey)
  const modelUrl = text(r.modelUrl)?.replace(/\/+$/, '')
  // A self-hosted proxy is identified by its address and may need no token; every other provider needs a key.
  if (!provider || (provider === 'proxy' ? !modelUrl : !apiKey)) return undefined
  return { provider, apiKey: apiKey ?? '', ...(provider === 'proxy' ? { modelUrl } : {}), pagesUrl: text(r.pagesUrl)?.replace(/\/+$/, ''), pagesToken: text(r.pagesToken), searchKey: text(r.searchKey) }
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
        ...(c.provider === 'proxy' ? { proxyUrl: c.modelUrl, authToken: c.apiKey } : { apiKey: c.apiKey }),
        // No address of their own: the build's default stands (the hosted proxy on /write, as on /try), else pages are not read.
        ...(c.pagesUrl && c.provider !== 'proxy' ? { webBackend: 'proxy' as const, proxyUrl: c.pagesUrl, authToken: c.pagesToken ?? '' } : {}),
        braveApiKey: c.searchKey,
      }
    : {}
  return resolveConfig({ ...buildDefaults, ...mine }).config
}

/** The proxy that reads web pages and searches: the one the writer set, else the build's default; none means links stay links. Separate from the model proxy, which may be a different machine. */
export function webProxyOf(c: WriteConnection | undefined, buildDefaults: Partial<AssistantConfig>): { url: string; token: string } | undefined {
  if (c?.pagesUrl) return { url: c.pagesUrl, token: c.pagesToken ?? '' }
  if (buildDefaults.webBackend === 'proxy' && buildDefaults.proxyUrl) return { url: buildDefaults.proxyUrl, token: buildDefaults.authToken ?? '' }
  return undefined
}
