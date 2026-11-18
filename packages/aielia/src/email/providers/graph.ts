import type { Account, Address, Attachment, Folder, FolderKind, Message, Thread } from '../model.js'
import type { NetworkPort } from '../network.js'
import type { TokenSource } from '../token-source.js'
import {
  EmailProviderError, type ChangeSet, type DraftInput, type EmailProvider, type MessageChange, type Page, type PageOptions, type SearchQuery,
} from '../provider.js'

/**
 * Microsoft Graph mail over its REST API (plans/aielia_email_plan.html, section 3, option B), called through the
 * network port with a token source. Pure code, no `node:*` and no DOM imports. A failure is an `EmailProviderError`
 * (response text is never copied into it); a sign-in problem is the token source's `SignInNeededError`.
 *
 * Mapping notes:
 * - A Graph message lives in exactly one folder. The model allows several (labels), so extra memberships are kept as
 *   message categories named `aielia/folder/<folder id>`; `move` clears them. `label` on a message's own folder is a no-op.
 * - Every call asks for immutable ids (`Prefer: IdType="ImmutableId"`), so a move keeps the message id.
 * - Bodies are requested as text. A message that still arrives as HTML carries its plain preview instead: no sanitiser
 *   exists yet and no HTML is carried.
 * - Delta queries are per folder, so the sync token is a JSON map of folder id to delta link. A changed folder set or
 *   an unreadable or expired token asks for a full resync.
 * - A sent message is a new item in Sent Items, so `send` looks it up by its internet message id.
 * - Page tokens are Graph `@odata.nextLink` addresses; only addresses under the API base are ever followed, so the
 *   access token cannot be sent to another host.
 */

export const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0'
const DEFAULT_LIMIT = 50
const MAX_PAGES = 40
const KEPT_HEADERS = ['message-id', 'in-reply-to', 'references', 'list-unsubscribe', 'list-id', 'authentication-results', 'reply-to']
export const GRAPH_FOLDER_CATEGORY_PREFIX = 'aielia/folder/'
const MESSAGE_SELECT = [
  'id', 'conversationId', 'parentFolderId', 'subject', 'from', 'toRecipients', 'ccRecipients', 'receivedDateTime', 'sentDateTime', 'createdDateTime',
  'isRead', 'isDraft', 'flag', 'categories', 'internetMessageHeaders', 'internetMessageId', 'body', 'bodyPreview', 'hasAttachments',
].join(',')
const WELL_KNOWN: Array<{ name: string; kind: FolderKind }> = [
  { name: 'inbox', kind: 'inbox' }, { name: 'sentitems', kind: 'sent' }, { name: 'drafts', kind: 'drafts' },
  { name: 'deleteditems', kind: 'trash' }, { name: 'archive', kind: 'archive' }, { name: 'junkemail', kind: 'junk' },
]

export interface GraphProviderOptions {
  account: Account
  network: NetworkPort
  tokens: TokenSource
  baseUrl?: string
}

interface GraphAddress { emailAddress?: { address?: string; name?: string } }
interface GraphMessage {
  id: string
  conversationId?: string
  parentFolderId?: string
  subject?: string
  from?: GraphAddress
  toRecipients?: GraphAddress[]
  ccRecipients?: GraphAddress[]
  receivedDateTime?: string
  sentDateTime?: string
  createdDateTime?: string
  isRead?: boolean
  isDraft?: boolean
  flag?: { flagStatus?: string }
  categories?: string[]
  internetMessageHeaders?: Array<{ name: string; value: string }>
  internetMessageId?: string
  body?: { contentType?: string; content?: string }
  bodyPreview?: string
  hasAttachments?: boolean
}
interface GraphFolder { id: string; displayName?: string; unreadItemCount?: number; childFolderCount?: number }
interface GraphCollection<T> { value?: T[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string }
interface DeltaItem extends Partial<GraphMessage> { id: string; '@removed'?: { reason?: string } }

export class GraphEmailProvider implements EmailProvider {
  readonly account: Account
  private readonly network: NetworkPort
  private readonly tokens: TokenSource
  private readonly base: string
  private wellKnownIds: Promise<Map<string, FolderKind>> | undefined

  constructor(opts: GraphProviderOptions) {
    this.account = opts.account
    this.network = opts.network
    this.tokens = opts.tokens
    this.base = opts.baseUrl ?? GRAPH_API_BASE
  }

  async listFolders(): Promise<Folder[]> {
    const kinds = await this.kinds()
    const out: Folder[] = []
    const walk = async (path: string, parentId?: string): Promise<void> => {
      for (const f of await this.collect<GraphFolder>(path, { $top: '100', $select: 'id,displayName,unreadItemCount,childFolderCount' })) {
        out.push({
          id: f.id, accountId: this.account.id, providerId: f.id, name: f.displayName ?? '', kind: kinds.get(f.id) ?? 'custom',
          ...(parentId ? { parentId } : {}), unreadCount: Math.max(0, f.unreadItemCount ?? 0),
        })
        if ((f.childFolderCount ?? 0) > 0) await walk(`/me/mailFolders/${enc(f.id)}/childFolders`, f.id)
      }
    }
    await walk('/me/mailFolders')
    return out
  }

  async listMessages(folderId: string, opts: PageOptions = {}): Promise<Page<Message>> {
    await this.requireFolder(folderId)
    const res = await this.callPage<GraphCollection<GraphMessage>>(opts.pageToken, `/me/mailFolders/${enc(folderId)}/messages`, {
      $select: MESSAGE_SELECT, $top: String(limitOf(opts)), $orderby: 'receivedDateTime desc',
      ...(opts.since ? { $filter: `receivedDateTime ge ${new Date(opts.since).toISOString()}` } : {}),
    })
    return pageOf(await this.toMessages(res.value ?? []), res['@odata.nextLink'])
  }

  async listThreads(folderId: string, opts: PageOptions = {}): Promise<Page<Thread>> {
    await this.requireFolder(folderId)
    const limit = limitOf(opts)
    // The token remembers which message page we were on, where in it, and which conversations were already listed.
    const state = this.decodeThreadToken(opts.pageToken)
    const seen = new Set(state.seen)
    const ids: string[] = []
    let pageUrl = state.pageUrl
    let idx = state.idx
    let next: ThreadToken | undefined
    for (let pages = 0; pages < MAX_PAGES && !next; pages++) {
      const res = await this.callPage<GraphCollection<GraphMessage>>(pageUrl, `/me/mailFolders/${enc(folderId)}/messages`, {
        $select: 'id,conversationId', $top: '50', $orderby: 'receivedDateTime desc',
      })
      const items = res.value ?? []
      for (let i = idx; i < items.length; i++) {
        const c = items[i]!.conversationId
        if (!c || seen.has(c)) continue
        seen.add(c)
        ids.push(c)
        if (ids.length >= limit) {
          // Resume inside this page, or at the next one when this page is spent.
          if (i + 1 < items.length) next = { pageUrl, idx: i + 1, seen: [...seen] }
          else if (res['@odata.nextLink']) next = { pageUrl: res['@odata.nextLink'], idx: 0, seen: [...seen] }
          break
        }
      }
      if (ids.length >= limit) break
      const link = res['@odata.nextLink']
      if (!link) break
      pageUrl = link
      idx = 0
    }
    const threads = await Promise.all(ids.map(async (id) => {
      const { thread } = await this.getThread(id)
      return thread
    }))
    return { items: threads, ...(next ? { nextPageToken: encodeThreadToken(next) } : {}) }
  }

  async getMessage(messageId: string): Promise<Message> {
    const g = await this.lookup(() => this.call<GraphMessage>('GET', `/me/messages/${enc(messageId)}`, { $select: MESSAGE_SELECT }))
    return (await this.toMessages([g]))[0]!
  }

  async getThread(threadId: string): Promise<{ thread: Thread; messages: Message[] }> {
    const raw = await this.collect<GraphMessage>('/me/messages', { $filter: `conversationId eq '${odataString(threadId)}'`, $select: MESSAGE_SELECT, $top: '50' })
    if (raw.length === 0) throw new EmailProviderError('not_found', 'No such thread.')
    const messages = (await this.toMessages(raw)).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
    return { thread: this.toThread(threadId, messages), messages }
  }

  async search(q: SearchQuery, opts: PageOptions = {}): Promise<Page<Message>> {
    if (q.folderId) await this.requireFolder(q.folderId)
    const path = q.folderId ? `/me/mailFolders/${enc(q.folderId)}/messages` : '/me/messages'
    const limit = limitOf(opts)
    const text = (q.text ?? '').split('"').join(' ').trim()
    const query: Record<string, string | undefined> = { $select: MESSAGE_SELECT, $top: String(limit) }
    if (text) {
      // Graph does not allow $search together with $filter; the other criteria are applied below.
      query['$search'] = `"${text}"`
    } else {
      const filters: string[] = []
      if (q.unreadOnly) filters.push('isRead eq false')
      if (q.after) filters.push(`receivedDateTime ge ${isoOf(q.after)}`)
      if (q.before) filters.push(`receivedDateTime le ${isoOf(q.before)}`)
      if (filters.length) query['$filter'] = filters.join(' and ')
    }
    const items: Message[] = []
    let url = opts.pageToken
    let next: string | undefined
    for (let pages = 0; pages < MAX_PAGES; pages++) {
      const res = await this.callPage<GraphCollection<GraphMessage>>(url, path, query)
      items.push(...(await this.toMessages(res.value ?? [])).filter((m) => matchesQuery(m, q)))
      next = res['@odata.nextLink']
      if (!next || items.length >= limit) break
      url = next
    }
    // A page is returned whole: filtering happens after the fetch, so the count can pass the limit by under one page.
    return pageOf(items, next)
  }

  async move(messageIds: string[], folderId: string): Promise<void> {
    await this.requireFolder(folderId)
    const msgs = await this.requireMessages(messageIds)
    for (const m of msgs) {
      await this.call('POST', `/me/messages/${enc(m.id)}/move`, undefined, { destinationId: folderId })
      const rest = (m.categories ?? []).filter((c) => !c.startsWith(GRAPH_FOLDER_CATEGORY_PREFIX))
      if (rest.length !== (m.categories ?? []).length) await this.call('PATCH', `/me/messages/${enc(m.id)}`, undefined, { categories: rest })
    }
  }

  async label(messageIds: string[], folderId: string, add: boolean): Promise<void> {
    await this.requireFolder(folderId)
    const msgs = await this.requireMessages(messageIds)
    const tag = `${GRAPH_FOLDER_CATEGORY_PREFIX}${folderId}`
    for (const m of msgs) {
      if (m.parentFolderId === folderId) continue
      const has = (m.categories ?? []).includes(tag)
      if (add === has) continue
      const categories = add ? [...(m.categories ?? []), tag] : (m.categories ?? []).filter((c) => c !== tag)
      await this.call('PATCH', `/me/messages/${enc(m.id)}`, undefined, { categories })
    }
  }

  async flag(messageIds: string[], starred: boolean): Promise<void> {
    const msgs = await this.requireMessages(messageIds)
    for (const m of msgs) await this.call('PATCH', `/me/messages/${enc(m.id)}`, undefined, { flag: { flagStatus: starred ? 'flagged' : 'notFlagged' } })
  }

  async markRead(messageIds: string[], read: boolean): Promise<void> {
    const msgs = await this.requireMessages(messageIds)
    for (const m of msgs) await this.call('PATCH', `/me/messages/${enc(m.id)}`, undefined, { isRead: read })
  }

  async createDraft(draft: DraftInput): Promise<Message> {
    if (draft.to.length === 0) throw new EmailProviderError('invalid_argument', 'A draft needs at least one recipient.')
    const fields = {
      subject: draft.subject,
      body: { contentType: 'text', content: draft.textBody },
      toRecipients: draft.to.map(toGraphAddress),
      ccRecipients: (draft.cc ?? []).map(toGraphAddress),
      bccRecipients: (draft.bcc ?? []).map(toGraphAddress),
    }
    if (draft.threadId) {
      const { messages } = await this.getThread(draft.threadId)
      const last = messages[messages.length - 1]!
      const reply = await this.call<GraphMessage>('POST', `/me/messages/${enc(last.id)}/createReply`)
      await this.call('PATCH', `/me/messages/${enc(reply.id)}`, undefined, fields)
      return this.getMessage(reply.id)
    }
    const created = await this.call<GraphMessage>('POST', '/me/messages', undefined, fields)
    return this.getMessage(created.id)
  }

  async send(draftId: string): Promise<Message> {
    const draft = await this.getMessage(draftId)
    if (!draft.flags.draft) throw new EmailProviderError('invalid_argument', `Message ${draftId} is not a draft.`)
    await this.call('POST', `/me/messages/${enc(draftId)}/send`)
    // The sent copy is a new item in Sent Items; find it by the internet message id the draft already had.
    const sentFolder = [...(await this.kinds()).entries()].find(([, k]) => k === 'sent')?.[0]
    const internetId = draft.headers['message-id']
    if (sentFolder && internetId) {
      const found = await this.collect<GraphMessage>(`/me/mailFolders/${enc(sentFolder)}/messages`, {
        $filter: `internetMessageId eq '${odataString(internetId)}'`, $select: MESSAGE_SELECT, $top: '5',
      })
      if (found[0]) return (await this.toMessages([found[0]]))[0]!
    }
    // The send succeeded but the copy is not visible yet: report it as sent rather than failing (a retry would send twice).
    return { ...draft, folderIds: sentFolder ? [sentFolder] : [], flags: { ...draft.flags, draft: false } }
  }

  async delete(messageIds: string[]): Promise<void> {
    const msgs = await this.requireMessages(messageIds)
    const trash = [...(await this.kinds()).entries()].find(([, k]) => k === 'trash')?.[0]
    for (const m of msgs) {
      if (trash && m.parentFolderId === trash) await this.call('POST', `/me/messages/${enc(m.id)}/permanentDelete`)
      else await this.call('POST', `/me/messages/${enc(m.id)}/move`, undefined, { destinationId: 'deleteditems' })
    }
  }

  async listChanges(syncToken?: string): Promise<ChangeSet> {
    const folders = await this.listFolders()
    const ids = folders.map((f) => f.id)
    if (syncToken === undefined) return { changes: [], syncToken: encodeSyncToken(await this.deltaLinks(ids, undefined)), fullResyncNeeded: false }
    const known = decodeSyncToken(syncToken, this.base)
    if (!known || ids.length !== Object.keys(known).length || ids.some((id) => !(id in known))) {
      return { changes: [], syncToken: encodeSyncToken(await this.deltaLinks(ids, undefined)), fullResyncNeeded: true }
    }
    const last = new Map<string, MessageChange>()
    try {
      const links = await this.deltaLinks(ids, known, (item) => {
        // A message that left this folder but still exists shows up as an upsert in its new folder.
        if (item['@removed']) {
          if (item['@removed'].reason === 'deleted') last.set(item.id, { type: 'delete', messageId: item.id })
        } else if (last.get(item.id)?.type !== 'delete') last.set(item.id, { type: 'upsert', messageId: item.id })
      })
      return { changes: [...last.values()], syncToken: encodeSyncToken(links), fullResyncNeeded: false }
    } catch (e) {
      // An expired delta link: the cache must be dropped and listed again.
      if (e instanceof EmailProviderError && (e.code === 'not_found' || e.code === 'invalid_argument')) {
        return { changes: [], syncToken: encodeSyncToken(await this.deltaLinks(ids, undefined)), fullResyncNeeded: true }
      }
      throw e
    }
  }

  // --- internals ---

  /** Follow each folder's delta to its end; returns the new delta link per folder. */
  private async deltaLinks(folderIds: string[], from: Record<string, string> | undefined, onItem?: (item: DeltaItem) => void): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    for (const id of folderIds) {
      let url: string | undefined = from?.[id]
      let first = true
      for (let pages = 0; pages < 500; pages++) {
        const res: GraphCollection<DeltaItem> = first && !url
          ? await this.call<GraphCollection<DeltaItem>>('GET', `/me/mailFolders/${enc(id)}/messages/delta`, { $select: 'id' })
          : await this.callPage<GraphCollection<DeltaItem>>(url, '')
        first = false
        if (from) for (const item of res.value ?? []) onItem?.(item)
        if (res['@odata.nextLink']) { url = res['@odata.nextLink']; continue }
        const link = res['@odata.deltaLink']
        if (!link) throw new EmailProviderError('unavailable', 'Graph returned no delta link.')
        this.checkAddress(link)
        out[id] = link
        break
      }
      if (!(id in out)) throw new EmailProviderError('unavailable', 'Graph delta did not finish.')
    }
    return out
  }

  private kinds(): Promise<Map<string, FolderKind>> {
    this.wellKnownIds ??= Promise.all(WELL_KNOWN.map(async (w) => {
      try {
        const f = await this.call<GraphFolder>('GET', `/me/mailFolders/${w.name}`, { $select: 'id' })
        return [f.id, w.kind] as const
      } catch (e) {
        // A mailbox may have no archive or junk folder yet; any other failure (sign-in, rate limit, outage) is real.
        if ((w.kind === 'archive' || w.kind === 'junk') && e instanceof EmailProviderError && (e.code === 'not_found' || e.code === 'invalid_argument')) return undefined
        throw e
      }
    })).then((pairs) => new Map(pairs.filter((p): p is readonly [string, FolderKind] => p !== undefined)))
    this.wellKnownIds.catch(() => { this.wellKnownIds = undefined })
    return this.wellKnownIds
  }

  private async requireFolder(folderId: string): Promise<void> {
    await this.lookup(() => this.call('GET', `/me/mailFolders/${enc(folderId)}`, { $select: 'id' }))
  }

  /** Fetch each message at minimal cost; an unknown id is `not_found` before anything is changed. */
  private async requireMessages(ids: string[]): Promise<GraphMessage[]> {
    const out: GraphMessage[] = []
    for (let i = 0; i < ids.length; i += 20) {
      out.push(...(await Promise.all(ids.slice(i, i + 20).map((id) => this.lookup(() => this.call<GraphMessage>('GET', `/me/messages/${enc(id)}`, { $select: 'id,parentFolderId,categories' }))))))
    }
    return out
  }

  /** Graph answers an unknown or malformed id with 404 or 400; both mean "no such item" here. */
  private async lookup<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (e) {
      if (e instanceof EmailProviderError && e.code === 'invalid_argument') throw new EmailProviderError('not_found', 'Graph does not know that item.')
      throw e
    }
  }

  private async toMessages(raw: GraphMessage[]): Promise<Message[]> {
    return Promise.all(raw.map(async (g) => {
      const attachments = g.hasAttachments ? await this.attachmentsOf(g.id) : []
      return this.toMessage(g, attachments)
    }))
  }

  private async attachmentsOf(messageId: string): Promise<Attachment[]> {
    const rows = await this.collect<{ id: string; name?: string; contentType?: string; size?: number; isInline?: boolean }>(
      `/me/messages/${enc(messageId)}/attachments`, { $select: 'id,name,contentType,size,isInline' },
    )
    return rows.map((a) => ({
      id: a.id, filename: a.name ?? '', mimeType: a.contentType || 'application/octet-stream', sizeBytes: Math.max(0, a.size ?? 0), ...(a.isInline ? { inline: true } : {}),
    }))
  }

  private toMessage(g: GraphMessage, attachments: Attachment[]): Message {
    const headers: Record<string, string> = {}
    for (const h of g.internetMessageHeaders ?? []) {
      const k = h.name.toLowerCase()
      if (KEPT_HEADERS.includes(k) && !(k in headers)) headers[k] = h.value
    }
    if (!headers['message-id'] && g.internetMessageId) headers['message-id'] = g.internetMessageId
    const folderIds = [...(g.parentFolderId ? [g.parentFolderId] : []), ...(g.categories ?? []).filter((c) => c.startsWith(GRAPH_FOLDER_CATEGORY_PREFIX)).map((c) => c.slice(GRAPH_FOLDER_CATEGORY_PREFIX.length))]
    const body = g.body?.contentType?.toLowerCase() === 'text' ? (g.body.content ?? '') : (g.bodyPreview ?? '')
    return {
      id: g.id, accountId: this.account.id, threadId: g.conversationId ?? g.id, providerId: g.id, folderIds: [...new Set(folderIds)],
      from: fromGraph(g.from) ?? { address: 'unknown@invalid' }, to: (g.toRecipients ?? []).map(fromGraph).filter(isAddress), cc: (g.ccRecipients ?? []).map(fromGraph).filter(isAddress),
      subject: g.subject ?? '', date: safeDate(g.receivedDateTime ?? g.sentDateTime ?? g.createdDateTime), headers, textBody: body.split('\r\n').join('\n'),
      // No HTML is carried: no sanitiser exists yet, and `htmlBody` must be already sanitised.
      attachments, flags: { read: g.isRead === true, starred: g.flag?.flagStatus === 'flagged', draft: g.isDraft === true },
    }
  }

  private toThread(id: string, messages: Message[]): Thread {
    const people = new Map<string, Address>()
    for (const m of messages) for (const a of [m.from, ...m.to]) if (!people.has(a.address.toLowerCase())) people.set(a.address.toLowerCase(), a)
    return {
      id, accountId: this.account.id, providerId: id, subject: messages[0]?.subject ?? '', messageIds: messages.map((m) => m.id),
      folderIds: [...new Set(messages.flatMap((m) => m.folderIds))], participants: [...people.values()],
      lastMessageAt: messages.map((m) => m.date).sort().at(-1) ?? new Date(0).toISOString(), unread: messages.some((m) => !m.flags.read),
    }
  }

  private decodeThreadToken(token: string | undefined): ThreadToken {
    if (!token) return { pageUrl: undefined, idx: 0, seen: [] }
    try {
      const t = JSON.parse(token) as ThreadToken
      if (!Array.isArray(t.seen) || typeof t.idx !== 'number') throw new Error('shape')
      if (t.pageUrl) this.checkAddress(t.pageUrl)
      return { pageUrl: t.pageUrl || undefined, idx: t.idx, seen: t.seen.filter((s) => typeof s === 'string') }
    } catch {
      throw new EmailProviderError('invalid_argument', 'Bad page token.')
    }
  }

  /** Only addresses under the API base are followed. */
  private checkAddress(url: string): void {
    if (!url.startsWith(`${this.base}/`)) throw new EmailProviderError('invalid_argument', 'Bad page token.')
  }

  /** The first page of `path`, or the page a token points at. */
  private callPage<T>(token: string | undefined, path: string, query?: Record<string, string | undefined>): Promise<T> {
    if (token) {
      this.checkAddress(token)
      return this.callUrl<T>('GET', token)
    }
    return this.call<T>('GET', path, query)
  }

  /** Every item of a collection, following next links. */
  private async collect<T>(path: string, query?: Record<string, string | undefined>): Promise<T[]> {
    const out: T[] = []
    let res = await this.call<GraphCollection<T>>('GET', path, query)
    for (let pages = 0; ; pages++) {
      out.push(...(res.value ?? []))
      const next = res['@odata.nextLink']
      if (!next || pages >= MAX_PAGES) return out
      res = await this.callPage<GraphCollection<T>>(next, '')
    }
  }

  private call<T = unknown>(method: string, path: string, query?: Record<string, string | undefined>, body?: unknown): Promise<T> {
    const qs = Object.entries(query ?? {}).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v!)}`).join('&')
    return this.callUrl<T>(method, `${this.base}${path}${qs ? `?${qs}` : ''}`, body)
  }

  private async callUrl<T>(method: string, url: string, body?: unknown): Promise<T> {
    const token = await this.tokens.getAccessToken()
    const res = await this.network({
      url, method,
      headers: {
        authorization: `Bearer ${token}`, accept: 'application/json',
        prefer: 'IdType="ImmutableId", outlook.body-content-type="text"',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    if (res.status < 200 || res.status >= 300) throw httpError(res.status)
    if (!text.trim()) return undefined as T
    try {
      return JSON.parse(text) as T
    } catch {
      throw new EmailProviderError('unavailable', 'Graph returned an unreadable response.')
    }
  }
}

interface ThreadToken { pageUrl: string | undefined; idx: number; seen: string[] }
function encodeThreadToken(t: ThreadToken): string {
  return JSON.stringify(t)
}
function encodeSyncToken(links: Record<string, string>): string {
  return JSON.stringify(links)
}
function decodeSyncToken(token: string, base: string): Record<string, string> | undefined {
  try {
    const t = JSON.parse(token) as unknown
    if (!t || typeof t !== 'object' || Array.isArray(t)) return undefined
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(t)) {
      if (typeof v !== 'string' || !v.startsWith(`${base}/`)) return undefined
      out[k] = v
    }
    return out
  } catch {
    return undefined
  }
}

function enc(id: string): string {
  return encodeURIComponent(id)
}
function odataString(s: string): string {
  return s.split("'").join("''")
}
function limitOf(opts: PageOptions): number {
  return Math.min(100, Math.max(1, opts.limit ?? DEFAULT_LIMIT))
}
function isoOf(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) throw new EmailProviderError('invalid_argument', `Bad date ${iso}.`)
  return new Date(ms).toISOString()
}
function safeDate(v: string | undefined): string {
  const ms = v ? Date.parse(v) : NaN
  return new Date(Number.isNaN(ms) ? 0 : ms).toISOString()
}
function pageOf<T>(items: T[], next: string | undefined): Page<T> {
  return { items, ...(next ? { nextPageToken: next } : {}) }
}
function toGraphAddress(a: { address: string; name?: string }): GraphAddress {
  return { emailAddress: { address: a.address, ...(a.name ? { name: a.name } : {}) } }
}
function fromGraph(a: GraphAddress | undefined): Address | undefined {
  const address = a?.emailAddress?.address
  if (!address) return undefined
  return { address, ...(a?.emailAddress?.name ? { name: a.emailAddress.name } : {}) }
}
function isAddress(a: Address | undefined): a is Address {
  return a !== undefined
}

/** The criteria Graph could not apply itself (`$search` excludes `$filter`), applied to what came back. */
function matchesQuery(m: Message, q: SearchQuery): boolean {
  if (q.unreadOnly && m.flags.read) return false
  if (q.from) {
    const f = q.from.toLowerCase()
    if (!m.from.address.toLowerCase().includes(f) && !(m.from.name ?? '').toLowerCase().includes(f)) return false
  }
  if (q.after && m.date < isoOf(q.after)) return false
  if (q.before && m.date > isoOf(q.before)) return false
  if (q.folderId && !m.folderIds.includes(q.folderId)) return false
  return true
}

function httpError(status: number): EmailProviderError {
  // Only the status is reported; response text is never copied into an error (it may echo mail content).
  if (status === 401) return new EmailProviderError('unauthorized', 'Graph rejected the access token.')
  if (status === 403) return new EmailProviderError('unauthorized', 'Graph refused the request (missing permission).')
  if (status === 404 || status === 410) return new EmailProviderError('not_found', 'Graph does not know that item.')
  if (status === 429) return new EmailProviderError('rate_limited', 'Graph rate limit reached.')
  if (status >= 400 && status < 500) return new EmailProviderError('invalid_argument', `Graph refused the request (${status}).`)
  return new EmailProviderError('unavailable', `Graph is unavailable (${status}).`)
}
