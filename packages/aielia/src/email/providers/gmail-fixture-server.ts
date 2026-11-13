import type { NetworkPort, NetworkRequest, NetworkResponse } from '../network.js'
import type { Message } from '../model.js'
import { generateSyntheticMailbox, type SyntheticMailbox } from '../synthetic-mailbox.js'
import { GMAIL_API_BASE } from './gmail.js'
import { base64ToUtf8, decodeEncodedWords, encodeHeaderValue, formatAddress, parseRawMessage, toBase64Url } from './mime.js'

/**
 * Test support: an in-memory stand-in for the Gmail REST API, served through the network port. The response shapes
 * (labels, messages with `payload.headers` and base64url bodies, threads, drafts, history records, error bodies)
 * follow Google's documented shapes and are written by hand here; no real account, no network. It is synthetic data
 * only, seeded from the synthetic mailbox. Not exported from the package index.
 */

interface GMsg { id: string; threadId: string; labelIds: string[]; internalDate: number; headers: Array<{ name: string; value: string }>; body: string; attachments: Array<{ id: string; filename: string; mimeType: string; size: number }> }
interface GLabel { id: string; name: string; type: 'system' | 'user' }

const SYSTEM_BY_KIND: Record<string, string> = { inbox: 'INBOX', sent: 'SENT', drafts: 'DRAFT', trash: 'TRASH' }

export class GmailFixtureServer {
  private labels: GLabel[] = [
    { id: 'UNREAD', name: 'UNREAD', type: 'system' }, { id: 'STARRED', name: 'STARRED', type: 'system' },
    { id: 'CATEGORY_PROMOTIONS', name: 'CATEGORY_PROMOTIONS', type: 'system' },
  ]
  private msgs = new Map<string, GMsg>()
  private drafts = new Map<string, string>()
  private history: Array<{ id: number; record: Record<string, unknown> }> = []
  private historyId = 1000
  private floor = 0
  private seq = 0
  /** Requests seen, for tests that assert on traffic. */
  readonly requests: NetworkRequest[] = []
  /** Forced failure for the next request (tests of error mapping). */
  failNext?: { status: number; body?: string }
  readonly ownerAddress: string
  readonly ownerName: string

  constructor(mailbox: SyntheticMailbox = generateSyntheticMailbox()) {
    this.ownerAddress = mailbox.account.address
    this.ownerName = mailbox.account.displayName
    const labelOf = new Map<string, string>()
    let n = 0
    for (const f of mailbox.folders) {
      const sys = SYSTEM_BY_KIND[f.kind]
      const id = sys ?? `Label_${++n}`
      labelOf.set(f.id, id)
      this.labels.push({ id, name: f.name, type: sys ? 'system' : 'user' })
    }
    for (const m of mailbox.messages) this.msgs.set(m.id, this.fromModel(m, m.folderIds.map((f) => labelOf.get(f)!)))
  }

  /** The network port to hand to the provider. */
  readonly port: NetworkPort = async (req) => this.handle(req)

  /** Test hook: forget history, so an old history id answers 404 as Gmail's does after about a week. */
  expireHistory(): void {
    this.floor = this.historyId + 1
    this.history = []
  }

  /** Test hook: an inbound message arrives. */
  deliver(from: { address: string; name?: string }, subject: string, text: string): string {
    const id = `gm-new-${++this.seq}`
    this.msgs.set(id, this.fromModel({
      id, accountId: 'x', threadId: `th-${id}`, providerId: id, folderIds: [], from, to: [{ address: this.ownerAddress }], cc: [], subject,
      date: new Date(Date.UTC(2026, 10, 2, 0, 0, this.seq)).toISOString(), headers: { 'message-id': `<${id}@example.com>` }, textBody: text, attachments: [],
      flags: { read: false, starred: false, draft: false },
    }, ['INBOX', 'UNREAD']))
    this.record({ messagesAdded: [{ message: { id, threadId: `th-${id}` } }] })
    return id
  }

  private fromModel(m: Message, labelIds: string[]): GMsg {
    const labels = [...labelIds]
    if (!m.flags.read) labels.push('UNREAD')
    if (m.flags.starred) labels.push('STARRED')
    const headers = [
      { name: 'From', value: formatAddress(m.from) }, { name: 'To', value: m.to.map(formatAddress).join(', ') },
      { name: 'Subject', value: encodeHeaderValue(m.subject) }, { name: 'Date', value: new Date(m.date).toUTCString() },
      ...Object.entries(m.headers).map(([name, value]) => ({ name, value })),
    ]
    return { id: m.id, threadId: m.threadId, labelIds: [...new Set(labels)], internalDate: Date.parse(m.date), headers, body: m.textBody, attachments: [] }
  }

  private record(record: Record<string, unknown>): void {
    this.historyId += 1
    this.history.push({ id: this.historyId, record })
  }

  private json(status: number, body: unknown): NetworkResponse {
    const text = body === undefined ? '' : JSON.stringify(body)
    return { status, headers: { 'content-type': 'application/json' }, text: async () => text }
  }
  private err(status: number, message: string, reason = 'notFound'): NetworkResponse {
    return this.json(status, { error: { code: status, message, errors: [{ reason }], status: 'ERR' } })
  }

  private wire(m: GMsg, format: string): unknown {
    const base = { id: m.id, threadId: m.threadId, labelIds: m.labelIds, snippet: m.body.slice(0, 80), historyId: String(this.historyId), internalDate: String(m.internalDate), sizeEstimate: m.body.length }
    if (format === 'minimal') return base
    const text = { mimeType: 'text/plain', body: { size: m.body.length, data: toBase64Url(m.body) }, filename: '' }
    const parts = [text, ...m.attachments.map((a) => ({ mimeType: a.mimeType, filename: a.filename, body: { size: a.size, attachmentId: a.id } }))]
    const payload = { partId: '', mimeType: 'multipart/mixed', filename: '', headers: m.headers, parts: format === 'full' ? parts : undefined }
    return { ...base, payload }
  }

  private handle(req: NetworkRequest): NetworkResponse {
    this.requests.push(req)
    if (this.failNext) {
      const f = this.failNext
      this.failNext = undefined
      return this.json(f.status, f.body ? JSON.parse(f.body) : { error: { code: f.status, message: 'forced' } })
    }
    if (!/^Bearer \S+$/.test(req.headers?.authorization ?? '')) return this.err(401, 'Invalid Credentials', 'authError')
    const url = new URL(req.url)
    if (!req.url.startsWith(GMAIL_API_BASE)) return this.err(404, 'Not Found')
    const path = url.pathname.slice(new URL(GMAIL_API_BASE).pathname.length)
    const q = url.searchParams
    const method = req.method ?? 'GET'
    const body = req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {}
    let m: RegExpExecArray | null

    if (method === 'GET' && path === '/profile') return this.json(200, { emailAddress: this.ownerAddress, historyId: String(this.historyId) })
    if (method === 'GET' && path === '/labels') return this.json(200, { labels: this.labels })
    if (method === 'GET' && (m = /^\/labels\/([^/]+)$/.exec(path))) {
      const id = decodeURIComponent(m[1])
      const l = this.labels.find((x) => x.id === id)
      if (!l) return this.err(404, 'Requested entity was not found.')
      const inLabel = [...this.msgs.values()].filter((x) => x.labelIds.includes(id))
      return this.json(200, { ...l, messagesTotal: inLabel.length, messagesUnread: inLabel.filter((x) => x.labelIds.includes('UNREAD')).length })
    }
    if (method === 'GET' && path === '/messages') {
      const hits = this.query([...this.msgs.values()], q.get('q') ?? '', q.get('labelIds'))
      const { slice, next } = paginate(hits.map((x) => x.id), q)
      return this.json(200, { messages: slice.map((id) => ({ id, threadId: this.msgs.get(id)!.threadId })), ...(next ? { nextPageToken: next } : {}), resultSizeEstimate: hits.length })
    }
    if (method === 'GET' && (m = /^\/messages\/([^/]+)$/.exec(path))) {
      const msg = this.msgs.get(decodeURIComponent(m[1]))
      return msg ? this.json(200, this.wire(msg, q.get('format') ?? 'full')) : this.err(404, 'Requested entity was not found.')
    }
    if (method === 'POST' && path === '/messages/batchModify') {
      const ids = (body.ids as string[]) ?? []
      const missing = ids.find((id) => !this.msgs.has(id))
      if (missing) return this.err(400, 'Invalid id value', 'invalid')
      for (const id of ids) {
        const msg = this.msgs.get(id)!
        const set = new Set(msg.labelIds)
        const added: string[] = []
        const removed: string[] = []
        for (const l of (body.addLabelIds as string[]) ?? []) if (!set.has(l)) { set.add(l); added.push(l) }
        for (const l of (body.removeLabelIds as string[]) ?? []) if (set.delete(l)) removed.push(l)
        msg.labelIds = [...set]
        const mm = { id, threadId: msg.threadId }
        if (added.length) this.record({ labelsAdded: [{ message: mm, labelIds: added }] })
        if (removed.length) this.record({ labelsRemoved: [{ message: mm, labelIds: removed }] })
      }
      return this.json(204, undefined)
    }
    if (method === 'POST' && (m = /^\/messages\/([^/]+)\/trash$/.exec(path))) {
      const msg = this.msgs.get(decodeURIComponent(m[1]))
      if (!msg) return this.err(404, 'Requested entity was not found.')
      const folderish = msg.labelIds.filter((l) => l !== 'UNREAD' && l !== 'STARRED')
      msg.labelIds = msg.labelIds.filter((l) => !folderish.includes(l)).concat('TRASH')
      this.record({ labelsAdded: [{ message: { id: msg.id, threadId: msg.threadId }, labelIds: ['TRASH'] }] })
      return this.json(200, this.wire(msg, 'minimal'))
    }
    if (method === 'POST' && path === '/messages/batchDelete') {
      for (const id of (body.ids as string[]) ?? []) {
        const msg = this.msgs.get(id)
        if (!msg) return this.err(400, 'Invalid id value', 'invalid')
        this.msgs.delete(id)
        for (const [d, mid] of this.drafts) if (mid === id) this.drafts.delete(d)
        this.record({ messagesDeleted: [{ message: { id, threadId: msg.threadId } }] })
      }
      return this.json(204, undefined)
    }
    if (method === 'GET' && path === '/threads') {
      const hits = this.query([...this.msgs.values()], '', q.get('labelIds'))
      const ids = [...new Set(hits.map((x) => x.threadId))]
      const { slice, next } = paginate(ids, q)
      return this.json(200, { threads: slice.map((id) => ({ id, snippet: '', historyId: String(this.historyId) })), ...(next ? { nextPageToken: next } : {}) })
    }
    if (method === 'GET' && (m = /^\/threads\/([^/]+)$/.exec(path))) {
      const id = decodeURIComponent(m[1])
      const ms = [...this.msgs.values()].filter((x) => x.threadId === id)
      if (ms.length === 0) return this.err(404, 'Requested entity was not found.')
      return this.json(200, { id, historyId: String(this.historyId), messages: ms.map((x) => this.wire(x, q.get('format') ?? 'full')) })
    }
    if (method === 'POST' && path === '/drafts') {
      const message = body.message as { raw: string; threadId?: string }
      const raw = parseRawMessage(base64ToUtf8(message.raw))
      const id = `gm-draft-${++this.seq}`
      const threadId = message.threadId ?? `th-${id}`
      if (message.threadId && ![...this.msgs.values()].some((x) => x.threadId === message.threadId)) return this.err(404, 'Requested entity was not found.')
      const headers = Object.entries(raw.headers).filter(([k]) => ['from', 'to', 'cc', 'subject', 'in-reply-to', 'references'].includes(k)).map(([k, v]) => ({ name: k[0].toUpperCase() + k.slice(1), value: v }))
      headers.push({ name: 'Message-ID', value: `<${id}@example.org>` })
      this.msgs.set(id, { id, threadId, labelIds: ['DRAFT'], internalDate: Date.UTC(2026, 10, 2, 1, 0, this.seq), headers, body: raw.textBody, attachments: [] })
      const draftId = `r-${id}`
      this.drafts.set(draftId, id)
      this.record({ messagesAdded: [{ message: { id, threadId } }] })
      return this.json(200, { id: draftId, message: { id, threadId, labelIds: ['DRAFT'] } })
    }
    if (method === 'GET' && path === '/drafts') {
      const all = [...this.drafts.entries()].map(([id, mid]) => ({ id, message: { id: mid, threadId: this.msgs.get(mid)!.threadId } }))
      const { slice, next } = paginate(all.map((d) => d.id), q)
      return this.json(200, { drafts: all.filter((d) => slice.includes(d.id)), ...(next ? { nextPageToken: next } : {}) })
    }
    if (method === 'POST' && path === '/drafts/send') {
      const mid = this.drafts.get(body.id as string)
      const msg = mid ? this.msgs.get(mid) : undefined
      if (!msg) return this.err(404, 'Requested entity was not found.')
      msg.labelIds = ['SENT']
      this.drafts.delete(body.id as string)
      this.record({ labelsRemoved: [{ message: { id: msg.id, threadId: msg.threadId }, labelIds: ['DRAFT'] }] })
      return this.json(200, { id: msg.id, threadId: msg.threadId, labelIds: msg.labelIds })
    }
    if (method === 'GET' && path === '/history') {
      const start = Number(q.get('startHistoryId'))
      if (!Number.isInteger(start) || start < this.floor || start > this.historyId) return this.err(404, 'Requested entity was not found.')
      const hits = this.history.filter((h) => h.id > start)
      const { slice, next } = paginate(hits.map((h) => String(h.id)), q)
      return this.json(200, { history: hits.filter((h) => slice.includes(String(h.id))).map((h) => ({ id: String(h.id), ...h.record })), historyId: String(this.historyId), ...(next ? { nextPageToken: next } : {}) })
    }
    return this.err(404, 'Not Found')
  }

  /** The subset of Gmail search syntax the provider emits: words, from:, is:unread, after:, before: (epoch seconds). */
  private query(all: GMsg[], q: string, labelId: string | null): GMsg[] {
    const words: string[] = []
    let from = ''
    let unread = false
    let after: number | undefined
    let before: number | undefined
    for (const tok of q.split(/\s+/).filter(Boolean)) {
      if (tok.startsWith('from:')) from = tok.slice(5).toLowerCase()
      else if (tok === 'is:unread') unread = true
      else if (tok.startsWith('after:')) after = Number(tok.slice(6)) * 1000
      else if (tok.startsWith('before:')) before = Number(tok.slice(7)) * 1000
      else words.push(tok.toLowerCase())
    }
    return all.filter((m) => {
      if (labelId && !m.labelIds.includes(labelId)) return false
      if (unread && !m.labelIds.includes('UNREAD')) return false
      if (after !== undefined && m.internalDate < after) return false
      if (before !== undefined && m.internalDate >= before) return false
      const h = (n: string) => m.headers.find((x) => x.name.toLowerCase() === n)?.value ?? ''
      if (from && !h('from').toLowerCase().includes(from)) return false
      const hay = `${decodeEncodedWords(h('subject'))}\n${h('from')}\n${m.body}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    }).sort((a, b) => b.internalDate - a.internalDate || a.id.localeCompare(b.id))
  }
}

function paginate(ids: string[], q: URLSearchParams): { slice: string[]; next?: string } {
  const max = Math.max(1, Number(q.get('maxResults') ?? 100))
  const start = q.get('pageToken') ? Number(q.get('pageToken')) : 0
  const slice = ids.slice(start, start + max)
  return { slice, next: start + max < ids.length ? String(start + max) : undefined }
}
