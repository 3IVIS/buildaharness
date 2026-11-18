import type { EmailCache } from './cache.js'
import type { Account, Message } from './model.js'
import { EmailProviderError, type EmailProvider } from './provider.js'

/**
 * Mail search with a scope (plans/aielia_email_capabilities_plan.html, C7): `local` (the cache; instant), `server` (the provider's own
 * search, which reaches mail outside the review window), `both`, or `auto` (local first, and the server too when the local answer is thin
 * or the question reaches back before the window). Server hits are stored in the cache as they arrive (tagged by the caller) so opening one
 * later is fast. A server failure or an offline provider never loses the local answer: it is reported and the local hits are returned.
 * Which messages the user lets Aielia read is not decided here: the caller passes `accept`, and a refused message only adds to `withheld`.
 * No `node:*` and no DOM imports.
 */

export type SearchScope = 'local' | 'server' | 'both' | 'auto'
export const SEARCH_SCOPES: readonly SearchScope[] = ['local', 'server', 'both', 'auto']

export interface MailSearchQuery {
  text?: string
  from?: string
  folderId?: string
  unreadOnly?: boolean
  /** ISO instant, inclusive. */
  after?: string
  /** ISO instant, exclusive. */
  before?: string
}

export interface SearchHit { message: Message; source: 'local' | 'server'; /** Older than the review window: the user has not "reviewed" this mail. */ outsideWindow: boolean }

export interface MailSearchDeps {
  account: Pick<Account, 'id'>
  cache: EmailCache
  /** Absent means the server cannot be searched (offline sample, no connection). */
  provider?: Pick<EmailProvider, 'search'>
  /** Start of the review window (ISO). Absent means everything counts as inside it. */
  windowSince?: string
  /** Decides whether the message may be shown to the model; a refused one is counted, never returned. */
  accept?: (m: Message) => boolean
  /** The account is read from a local mail program: there is no server to ask, however a provider is wired. */
  localOnly?: boolean
  /** Hits wanted (default 20). */
  limit?: number
  /** Local hits below this many make `auto` ask the server too (default 3). */
  thinBelow?: number
  /** Called with server hits that were not in the cache, after they are stored. */
  onCached?: (messages: Message[]) => void | Promise<void>
}

export interface MailSearchResult {
  hits: SearchHit[]
  /** Where the answer actually came from. */
  scopeUsed: 'local' | 'server' | 'both'
  /** Messages left out because the user excluded them or the account is off. */
  withheld: number
  /** Set when the server was wanted but could not answer; the local hits are still returned. */
  serverError?: { code: EmailProviderError['code'] | 'offline'; message: string }
  /** Set when the server was never consulted for lack of a provider. */
  serverUnavailable?: boolean
  /** With `serverUnavailable`: the account is read from a local mail program, which holds only what it downloaded. */
  localOnly?: boolean
}

const PAGE = 100

const textOf = (m: Message): string => `${m.subject}\n${m.from.address}\n${m.from.name ?? ''}\n${m.textBody}`.toLowerCase()

async function localHits(q: MailSearchQuery, d: MailSearchDeps, limit: number): Promise<{ hits: Message[]; withheld: number }> {
  const needle = q.text?.trim().toLowerCase()
  const from = q.from?.trim().toLowerCase()
  const out: Message[] = []
  let withheld = 0
  for (let offset = 0; out.length < limit; offset += PAGE) {
    const page = await d.cache.queryMessages(
      { ...(q.folderId ? { folderId: q.folderId } : {}), ...(q.unreadOnly ? { read: false } : {}), ...(q.after ? { since: q.after } : {}), ...(q.before ? { before: q.before } : {}) },
      { offset, limit: PAGE },
    )
    for (const m of page.items) {
      if (out.length >= limit) break
      if (m.accountId !== d.account.id) continue
      // Judge readability BEFORE matching text, so an excluded message's body can never decide what is shown.
      if (d.accept && !d.accept(m)) { withheld++; continue }
      if (from && !`${m.from.address} ${m.from.name ?? ''}`.toLowerCase().includes(from)) continue
      if (needle && !textOf(m).includes(needle)) continue
      out.push(m)
    }
    if (offset + PAGE >= page.total) break
  }
  return { hits: out, withheld }
}

const reachesBeforeWindow = (q: MailSearchQuery, since: string | undefined): boolean => !!since && (q.before !== undefined ? q.before <= since || (q.after !== undefined && q.after < since) : q.after !== undefined && q.after < since)

export async function searchMail(q: MailSearchQuery, scope: SearchScope, d: MailSearchDeps): Promise<MailSearchResult> {
  const limit = Math.min(50, Math.max(1, Math.floor(d.limit ?? 20)))
  const local = scope === 'server' ? { hits: [] as Message[], withheld: 0 } : await localHits(q, d, limit)
  const askServer = scope === 'server' || scope === 'both' || (scope === 'auto' && (local.hits.length < (d.thinBelow ?? 3) || reachesBeforeWindow(q, d.windowSince)))
  const outside = (m: Message): boolean => !!d.windowSince && m.date < d.windowSince
  const hits: SearchHit[] = local.hits.map((message) => ({ message, source: 'local', outsideWindow: outside(message) }))
  const result: MailSearchResult = { hits, scopeUsed: 'local', withheld: local.withheld }
  if (!askServer) return result
  if (d.localOnly) return { ...result, serverUnavailable: true, localOnly: true }
  if (!d.provider) return { ...result, serverUnavailable: true }

  const seen = new Set(hits.map((h) => h.message.id))
  const fresh: Message[] = []
  try {
    let pageToken: string | undefined
    for (let pages = 0; hits.length < limit && pages < 3; pages++) {
      const page = await d.provider.search({
        ...(q.text ? { text: q.text } : {}), ...(q.from ? { from: q.from } : {}), ...(q.folderId ? { folderId: q.folderId } : {}),
        ...(q.unreadOnly ? { unreadOnly: true } : {}), ...(q.after ? { after: q.after } : {}), ...(q.before ? { before: q.before } : {}),
      }, { limit: Math.min(50, limit * 2), ...(pageToken ? { pageToken } : {}) })
      for (const m of page.items) {
        if (hits.length >= limit) break
        if (seen.has(m.id) || m.accountId !== d.account.id) continue
        seen.add(m.id)
        if (d.accept && !d.accept(m)) { result.withheld++; continue }
        const cached = await d.cache.getMessage(m.id)
        if (!cached) fresh.push(m)
        hits.push({ message: cached ?? m, source: 'server', outsideWindow: outside(m) })
      }
      pageToken = page.nextPageToken
      if (!pageToken) break
    }
    result.scopeUsed = scope === 'server' ? 'server' : 'both'
  } catch (e) {
    result.serverError = e instanceof EmailProviderError ? { code: e.code, message: e.message } : { code: 'offline', message: e instanceof Error ? e.message : String(e) }
  }
  if (fresh.length > 0) {
    await d.cache.upsertMessages(fresh)
    await d.onCached?.(fresh)
  }
  hits.sort((a, b) => (a.message.date < b.message.date ? 1 : a.message.date > b.message.date ? -1 : a.message.id < b.message.id ? -1 : 1))
  return result
}
