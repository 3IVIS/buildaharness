import type { Account, Address, Attachment, Folder, FolderKind, Message, Thread } from '../model.js'
import type { NetworkPort } from '../network.js'
import type { TokenSource } from '../token-source.js'
import {
  EmailProviderError, type ChangeSet, type DraftInput, type EmailProvider, type MessageChange, type Page, type PageOptions, type SearchQuery,
} from '../provider.js'
import { base64ToUtf8, buildRawMessage, decodeEncodedWords, parseAddressList, toBase64Url } from './mime.js'

/**
 * Gmail over its REST API (plans/aielia_email_plan.html, section 3, option A), called through the network port with a
 * token source. Labels are folders; a message's folders are its labels minus the state labels (UNREAD, STARRED, ...).
 * Pure code, no `node:*` and no DOM imports. A failure is an `EmailProviderError`; a sign-in problem is the token
 * source's `SignInNeededError`, left to propagate.
 *
 * Scope note: permanent deletion (`messages/batchDelete`) needs the full-mail scope; moving to trash needs only modify.
 */

export const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'
const DEFAULT_LIMIT = 50
const BATCH_LIMIT = 1000
const KEPT_HEADERS = ['message-id', 'in-reply-to', 'references', 'list-unsubscribe', 'list-id', 'authentication-results', 'reply-to']
/** Labels that describe message state, not a place. */
const STATE_LABELS = new Set(['UNREAD', 'STARRED', 'IMPORTANT', 'CHAT'])
const SYSTEM_KINDS: Record<string, FolderKind> = { INBOX: 'inbox', SENT: 'sent', DRAFT: 'drafts', TRASH: 'trash', SPAM: 'junk' }

export interface GmailProviderOptions {
  account: Account
  network: NetworkPort
  tokens: TokenSource
  baseUrl?: string
}

interface GmailHeader { name: string; value: string }
interface GmailPart {
  partId?: string
  mimeType?: string
  filename?: string
  headers?: GmailHeader[]
  body?: { size?: number; data?: string; attachmentId?: string }
  parts?: GmailPart[]
}
interface GmailMessage { id: string; threadId: string; labelIds?: string[]; internalDate?: string; payload?: GmailPart }
interface GmailLabel { id: string; name: string; type?: string; messagesUnread?: number }

export class GmailEmailProvider implements EmailProvider {
  readonly account: Account
  private readonly network: NetworkPort
  private readonly tokens: TokenSource
  private readonly base: string

  constructor(opts: GmailProviderOptions) {
    this.account = opts.account
    this.network = opts.network
    this.tokens = opts.tokens
    this.base = opts.baseUrl ?? GMAIL_API_BASE
  }

  async listFolders(): Promise<Folder[]> {
    const list = await this.call<{ labels?: GmailLabel[] }>('GET', '/labels')
    const labels = (list.labels ?? []).filter(isFolderLabel)
    const full = await Promise.all(labels.map((l) => this.call<GmailLabel>('GET', `/labels/${encodeURIComponent(l.id)}`)))
    return full.map((l) => ({
      id: l.id, accountId: this.account.id, providerId: l.id, name: l.name, kind: SYSTEM_KINDS[l.id] ?? 'custom', unreadCount: Math.max(0, l.messagesUnread ?? 0),
    }))
  }

  async listMessages(folderId: string, opts: PageOptions = {}): Promise<Page<Message>> {
    await this.requireFolder(folderId)
    return this.messagePage({ labelIds: folderId, ...(opts.since ? { q: `after:${epochSeconds(opts.since)}` } : {}) }, opts)
  }

  async listThreads(folderId: string, opts: PageOptions = {}): Promise<Page<Thread>> {
    await this.requireFolder(folderId)
    const res = await this.call<{ threads?: Array<{ id: string }>; nextPageToken?: string }>('GET', '/threads', {
      labelIds: folderId, maxResults: String(limitOf(opts)), pageToken: opts.pageToken, q: opts.since ? `after:${epochSeconds(opts.since)}` : undefined,
    })
    const threads = await Promise.all((res.threads ?? []).map(async (t) => {
      const g = await this.call<{ id: string; messages?: GmailMessage[] }>('GET', `/threads/${encodeURIComponent(t.id)}`, { format: 'metadata' })
      return this.toThread(g.id, (g.messages ?? []).map((m) => this.toMessage(m)))
    }))
    return { items: threads, ...(res.nextPageToken ? { nextPageToken: res.nextPageToken } : {}) }
  }

  async getMessage(messageId: string): Promise<Message> {
    return this.toMessage(await this.call<GmailMessage>('GET', `/messages/${encodeURIComponent(messageId)}`, { format: 'full' }))
  }

  async getThread(threadId: string): Promise<{ thread: Thread; messages: Message[] }> {
    const g = await this.call<{ id: string; messages?: GmailMessage[] }>('GET', `/threads/${encodeURIComponent(threadId)}`, { format: 'full' })
    const messages = (g.messages ?? []).map((m) => this.toMessage(m)).sort((a, b) => a.date.localeCompare(b.date))
    return { thread: this.toThread(g.id, messages), messages }
  }

  async search(q: SearchQuery, opts: PageOptions = {}): Promise<Page<Message>> {
    const terms: string[] = []
    if (q.text) terms.push(q.text.replace(/["()]/g, ' ').trim())
    if (q.from) terms.push(`from:${q.from.replace(/[\s()"]/g, '')}`)
    if (q.unreadOnly) terms.push('is:unread')
    if (q.after) terms.push(`after:${epochSeconds(q.after)}`)
    if (q.before) terms.push(`before:${epochSeconds(q.before) + 1}`)
    if (q.folderId) await this.requireFolder(q.folderId)
    return this.messagePage({ q: terms.filter(Boolean).join(' ') || undefined, labelIds: q.folderId }, opts)
  }

  async move(messageIds: string[], folderId: string): Promise<void> {
    await this.requireFolder(folderId)
    const msgs = await this.requireMessages(messageIds)
    const remove = [...new Set(msgs.flatMap((m) => folderLabelsOf(m)))].filter((l) => l !== folderId)
    await this.modify(messageIds, [folderId], remove)
  }

  async label(messageIds: string[], folderId: string, add: boolean): Promise<void> {
    await this.requireFolder(folderId)
    await this.requireMessages(messageIds)
    await this.modify(messageIds, add ? [folderId] : [], add ? [] : [folderId])
  }

  async flag(messageIds: string[], starred: boolean): Promise<void> {
    await this.requireMessages(messageIds)
    await this.modify(messageIds, starred ? ['STARRED'] : [], starred ? [] : ['STARRED'])
  }

  async markRead(messageIds: string[], read: boolean): Promise<void> {
    await this.requireMessages(messageIds)
    await this.modify(messageIds, read ? [] : ['UNREAD'], read ? ['UNREAD'] : [])
  }

  async createDraft(draft: DraftInput): Promise<Message> {
    if (draft.to.length === 0) throw new EmailProviderError('invalid_argument', 'A draft needs at least one recipient.')
    let inReplyTo: string | undefined
    let references: string | undefined
    if (draft.threadId) {
      const { messages } = await this.getThread(draft.threadId)
      const last = messages[messages.length - 1]
      inReplyTo = last?.headers['message-id']
      references = [last?.headers['references'], inReplyTo].filter(Boolean).join(' ') || undefined
    }
    const raw = buildRawMessage({ from: { address: this.account.address, name: this.account.displayName || undefined }, to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject, textBody: draft.textBody, inReplyTo, references })
    const created = await this.call<{ id: string; message?: { id: string } }>('POST', '/drafts', undefined, {
      message: { raw: toBase64Url(raw), ...(draft.threadId ? { threadId: draft.threadId } : {}) },
    })
    return this.getMessage(created.message?.id ?? created.id)
  }

  async send(draftId: string): Promise<Message> {
    const m = await this.getMessage(draftId)
    if (!m.flags.draft) throw new EmailProviderError('invalid_argument', `Message ${draftId} is not a draft.`)
    let pageToken: string | undefined
    let gmailDraftId: string | undefined
    do {
      const res = await this.call<{ drafts?: Array<{ id: string; message?: { id: string } }>; nextPageToken?: string }>('GET', '/drafts', { maxResults: '100', pageToken })
      gmailDraftId = res.drafts?.find((d) => d.message?.id === draftId)?.id
      pageToken = gmailDraftId ? undefined : res.nextPageToken
    } while (pageToken)
    if (!gmailDraftId) throw new EmailProviderError('not_found', `No draft for message ${draftId}.`)
    const sent = await this.call<{ id: string }>('POST', '/drafts/send', undefined, { id: gmailDraftId })
    return this.getMessage(sent.id)
  }

  async delete(messageIds: string[]): Promise<void> {
    const msgs = await this.requireMessages(messageIds)
    const forGood = msgs.filter((m) => (m.labelIds ?? []).includes('TRASH')).map((m) => m.id)
    const toTrash = msgs.filter((m) => !(m.labelIds ?? []).includes('TRASH')).map((m) => m.id)
    for (const id of toTrash) await this.call('POST', `/messages/${encodeURIComponent(id)}/trash`)
    for (const chunk of chunks(forGood)) await this.call('POST', '/messages/batchDelete', undefined, { ids: chunk })
  }

  async listChanges(syncToken?: string): Promise<ChangeSet> {
    if (syncToken === undefined) return { changes: [], syncToken: await this.currentHistoryId(), fullResyncNeeded: false }
    const last = new Map<string, MessageChange>()
    let pageToken: string | undefined
    let historyId = syncToken
    try {
      do {
        const res = await this.call<{ history?: GmailHistory[]; historyId?: string; nextPageToken?: string }>('GET', '/history', { startHistoryId: syncToken, pageToken, maxResults: '500' })
        for (const h of res.history ?? []) {
          for (const e of h.messagesAdded ?? []) last.set(e.message.id, { type: 'upsert', messageId: e.message.id })
          for (const e of h.labelsAdded ?? []) last.set(e.message.id, { type: 'upsert', messageId: e.message.id })
          for (const e of h.labelsRemoved ?? []) last.set(e.message.id, { type: 'upsert', messageId: e.message.id })
          for (const e of h.messagesDeleted ?? []) last.set(e.message.id, { type: 'delete', messageId: e.message.id })
        }
        if (res.historyId) historyId = res.historyId
        pageToken = res.nextPageToken
      } while (pageToken)
    } catch (e) {
      // An unknown or expired history id: the cache must be dropped and listed again.
      if (e instanceof EmailProviderError && (e.code === 'not_found' || e.code === 'invalid_argument')) {
        return { changes: [], syncToken: await this.currentHistoryId(), fullResyncNeeded: true }
      }
      throw e
    }
    return { changes: [...last.values()], syncToken: historyId, fullResyncNeeded: false }
  }

  // --- internals ---

  private async currentHistoryId(): Promise<string> {
    const p = await this.call<{ historyId?: string }>('GET', '/profile')
    if (!p.historyId) throw new EmailProviderError('unavailable', 'Gmail returned no history id.')
    return String(p.historyId)
  }

  private async requireFolder(folderId: string): Promise<void> {
    const list = await this.call<{ labels?: GmailLabel[] }>('GET', '/labels')
    if (!(list.labels ?? []).some((l) => l.id === folderId && isFolderLabel(l))) throw new EmailProviderError('not_found', `No folder ${folderId}.`)
  }

  /** Fetch each message at minimal cost; an unknown id is `not_found` before anything is changed. */
  private async requireMessages(ids: string[]): Promise<GmailMessage[]> {
    const out: GmailMessage[] = []
    for (const group of chunks(ids, 20)) {
      out.push(...(await Promise.all(group.map((id) => this.call<GmailMessage>('GET', `/messages/${encodeURIComponent(id)}`, { format: 'minimal' })))))
    }
    return out
  }

  private async modify(ids: string[], add: string[], remove: string[]): Promise<void> {
    if (ids.length === 0) return
    for (const chunk of chunks(ids)) await this.call('POST', '/messages/batchModify', undefined, { ids: chunk, addLabelIds: add, removeLabelIds: remove })
  }

  private async messagePage(params: { q?: string; labelIds?: string }, opts: PageOptions): Promise<Page<Message>> {
    const res = await this.call<{ messages?: Array<{ id: string }>; nextPageToken?: string }>('GET', '/messages', {
      ...params, maxResults: String(limitOf(opts)), pageToken: opts.pageToken,
    })
    const items = await Promise.all((res.messages ?? []).map((m) => this.getMessage(m.id)))
    return { items, ...(res.nextPageToken ? { nextPageToken: res.nextPageToken } : {}) }
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

  private toMessage(g: GmailMessage): Message {
    const labels = g.labelIds ?? []
    const headers = headerMap(g.payload?.headers)
    const kept: Record<string, string> = {}
    for (const k of KEPT_HEADERS) if (headers[k] !== undefined) kept[k] = headers[k]
    const bodies = { text: '', attachments: [] as Attachment[] }
    walk(g.payload, bodies)
    const date = g.internalDate && /^\d+$/.test(g.internalDate) ? new Date(Number(g.internalDate)).toISOString() : safeDate(headers['date'])
    const from = parseAddressList(headers['from'] ? decodeEncodedWords(headers['from']) : undefined)[0] ?? { address: 'unknown@invalid' }
    return {
      id: g.id, accountId: this.account.id, threadId: g.threadId, providerId: g.id, folderIds: labels.filter((l) => !STATE_LABELS.has(l) && !l.startsWith('CATEGORY_')),
      from, to: parseAddressList(headers['to']), cc: parseAddressList(headers['cc']), subject: decodeEncodedWords(headers['subject'] ?? ''), date,
      headers: kept, textBody: bodies.text,
      // The HTML part is deliberately not carried: no sanitiser exists yet, and `htmlBody` must be already sanitised.
      attachments: bodies.attachments, flags: { read: !labels.includes('UNREAD'), starred: labels.includes('STARRED'), draft: labels.includes('DRAFT') },
    }
  }

  private async call<T = unknown>(method: string, path: string, query?: Record<string, string | undefined>, body?: unknown): Promise<T> {
    const qs = Object.entries(query ?? {}).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v!)}`).join('&')
    const token = await this.tokens.getAccessToken()
    const res = await this.network({
      url: `${this.base}${path}${qs ? `?${qs}` : ''}`, method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    if (res.status < 200 || res.status >= 300) throw httpError(res.status, text)
    if (!text.trim()) return undefined as T
    try {
      return JSON.parse(text) as T
    } catch {
      throw new EmailProviderError('unavailable', 'Gmail returned an unreadable response.')
    }
  }
}

interface GmailHistory {
  messagesAdded?: Array<{ message: { id: string } }>
  messagesDeleted?: Array<{ message: { id: string } }>
  labelsAdded?: Array<{ message: { id: string } }>
  labelsRemoved?: Array<{ message: { id: string } }>
}

function isFolderLabel(l: GmailLabel): boolean {
  return !STATE_LABELS.has(l.id) && !l.id.startsWith('CATEGORY_')
}
function folderLabelsOf(m: GmailMessage): string[] {
  return (m.labelIds ?? []).filter((l) => !STATE_LABELS.has(l) && !l.startsWith('CATEGORY_'))
}
function limitOf(opts: PageOptions): number {
  return Math.min(500, Math.max(1, opts.limit ?? DEFAULT_LIMIT))
}
function epochSeconds(iso: string): number {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) throw new EmailProviderError('invalid_argument', `Bad date ${iso}.`)
  return Math.floor(ms / 1000)
}
function safeDate(v: string | undefined): string {
  const ms = v ? Date.parse(v) : NaN
  return new Date(Number.isNaN(ms) ? 0 : ms).toISOString()
}
function chunks<T>(xs: T[], size = BATCH_LIMIT): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size))
  return out
}
function headerMap(hs: GmailHeader[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const h of hs ?? []) if (!(h.name.toLowerCase() in out)) out[h.name.toLowerCase()] = h.value
  return out
}

function walk(part: GmailPart | undefined, acc: { text: string; attachments: Attachment[] }): void {
  if (!part) return
  const mime = (part.mimeType ?? '').toLowerCase()
  if (part.filename && part.body?.attachmentId) {
    const h = headerMap(part.headers)
    acc.attachments.push({
      id: part.body.attachmentId, filename: part.filename, mimeType: mime || 'application/octet-stream', sizeBytes: part.body.size ?? 0,
      ...((h['content-disposition'] ?? '').toLowerCase().startsWith('inline') || h['content-id'] ? { inline: true } : {}),
    })
  } else if (mime === 'text/plain' && part.body?.data && !acc.text) {
    acc.text = base64ToUtf8(part.body.data)
  }
  for (const p of part.parts ?? []) walk(p, acc)
}

function httpError(status: number, body: string): EmailProviderError {
  // Only the status is reported; response text is never copied into an error (it may echo mail content).
  void body
  if (status === 401) return new EmailProviderError('unauthorized', 'Gmail rejected the access token.')
  if (status === 403 && /rateLimit|userRateLimit|quota/i.test(body)) return new EmailProviderError('rate_limited', 'Gmail rate limit reached.')
  if (status === 403) return new EmailProviderError('unauthorized', 'Gmail refused the request (missing permission).')
  if (status === 404) return new EmailProviderError('not_found', 'Gmail does not know that item.')
  if (status === 429) return new EmailProviderError('rate_limited', 'Gmail rate limit reached.')
  if (status >= 400 && status < 500) return new EmailProviderError('invalid_argument', `Gmail refused the request (${status}).`)
  return new EmailProviderError('unavailable', `Gmail is unavailable (${status}).`)
}
