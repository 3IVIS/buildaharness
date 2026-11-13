import type { NetworkPort, NetworkRequest, NetworkResponse } from '../network.js'
import type { Message } from '../model.js'
import { generateSyntheticMailbox, type SyntheticMailbox } from '../synthetic-mailbox.js'
import { GRAPH_API_BASE, GRAPH_FOLDER_CATEGORY_PREFIX } from './graph.js'

/**
 * Test support: an in-memory stand-in for the Microsoft Graph mail API, served through the network port. Response
 * shapes (mailFolders, messages with `conversationId` and `parentFolderId`, recipients as `emailAddress` objects,
 * `@odata.nextLink` paging, per-folder delta with `@removed`, error bodies) follow Microsoft's documented shapes and
 * are written by hand here; no real account, no network. Synthetic data only, seeded from the synthetic mailbox.
 * Not exported from the package index.
 */

interface GrMsg {
  id: string
  conversationId: string
  parentFolderId: string
  subject: string
  from: { address: string; name?: string }
  to: Array<{ address: string; name?: string }>
  cc: Array<{ address: string; name?: string }>
  bcc: Array<{ address: string; name?: string }>
  received: number
  isRead: boolean
  isDraft: boolean
  flagged: boolean
  categories: string[]
  headers: Array<{ name: string; value: string }>
  internetMessageId: string
  body: string
  attachments: Array<{ id: string; name: string; contentType: string; size: number; isInline: boolean }>
}
interface GrFolder { id: string; displayName: string; wellKnownName?: string; parentId?: string }

const WELL_KNOWN_BY_KIND: Record<string, string> = { inbox: 'inbox', sent: 'sentitems', drafts: 'drafts', trash: 'deleteditems', archive: 'archive' }
const PAGE_SIZE_DELTA = 15

export class GraphFixtureServer {
  private folders: GrFolder[] = []
  private msgs = new Map<string, GrMsg>()
  private log: Array<{ seq: number; id: string; folder: string }> = []
  private seq = 0
  private idSeq = 0
  private floor = 0
  /** Requests seen, for tests that assert on traffic. */
  readonly requests: NetworkRequest[] = []
  /** Forced failure for the next request (tests of error mapping). */
  failNext?: { status: number; body?: string }
  readonly ownerAddress: string

  constructor(mailbox: SyntheticMailbox = generateSyntheticMailbox()) {
    this.ownerAddress = mailbox.account.address
    const gidOf = new Map<string, string>()
    let n = 0
    for (const f of mailbox.folders) {
      const id = `AAMk-folder-${++n}`
      gidOf.set(f.id, id)
      this.folders.push({ id, displayName: f.name, wellKnownName: WELL_KNOWN_BY_KIND[f.kind] })
    }
    for (const m of mailbox.messages) {
      const gids = m.folderIds.map((f) => gidOf.get(f)!)
      this.msgs.set(m.id, this.fromModel(m, gids[0]!, gids.slice(1)))
    }
  }

  /** The network port to hand to the provider. */
  readonly port: NetworkPort = async (req) => this.handle(req)

  /** Test hook: forget change history, so an old delta link answers 410 as Graph's does once it expires. */
  expireDelta(): void {
    this.floor = this.seq + 1
    this.log = []
  }

  /** Test hook: an inbound message arrives in the inbox. */
  deliver(from: { address: string; name?: string }, subject: string, text: string): string {
    const id = `gr-new-${++this.idSeq}`
    const inbox = this.resolveFolder('inbox')!
    this.msgs.set(id, {
      id, conversationId: `conv-${id}`, parentFolderId: inbox.id, subject, from, to: [{ address: this.ownerAddress }], cc: [], bcc: [],
      received: Date.UTC(2026, 10, 2, 0, 0, this.idSeq), isRead: false, isDraft: false, flagged: false, categories: [], headers: [],
      internetMessageId: `<${id}@example.com>`, body: text, attachments: [],
    })
    this.touch(id, inbox.id)
    return id
  }

  /** Test hook: add a nested folder. */
  addChildFolder(parentName: string, name: string): string {
    const parent = this.folders.find((f) => f.displayName === parentName)!
    const id = `AAMk-folder-${this.folders.length + 1}`
    this.folders.push({ id, displayName: name, parentId: parent.id })
    return id
  }

  /** Test hook: give a message an attachment. */
  attach(messageId: string, name: string, contentType: string, size: number): void {
    this.msgs.get(messageId)!.attachments.push({ id: `att-${++this.idSeq}`, name, contentType, size, isInline: false })
  }

  /** Test hook: how many messages a folder holds, by well-known name. */
  count(wellKnown: string): number {
    const f = this.resolveFolder(wellKnown)!
    return [...this.msgs.values()].filter((m) => m.parentFolderId === f.id).length
  }

  private fromModel(m: Message, folder: string, extra: string[]): GrMsg {
    return {
      id: m.id, conversationId: m.threadId, parentFolderId: folder, subject: m.subject, from: m.from, to: m.to, cc: m.cc, bcc: [], received: Date.parse(m.date),
      isRead: m.flags.read, isDraft: m.flags.draft, flagged: m.flags.starred, categories: extra.map((f) => `${GRAPH_FOLDER_CATEGORY_PREFIX}${f}`),
      headers: Object.entries(m.headers).map(([name, value]) => ({ name, value })), internetMessageId: m.headers['message-id'] ?? `<${m.id}@example.com>`,
      body: m.textBody, attachments: [],
    }
  }

  private resolveFolder(idOrName: string): GrFolder | undefined {
    return this.folders.find((f) => f.id === idOrName) ?? this.folders.find((f) => f.wellKnownName === idOrName)
  }
  private touch(id: string, folder: string): void {
    this.seq += 1
    this.log.push({ seq: this.seq, id, folder })
  }

  private json(status: number, body: unknown): NetworkResponse {
    const text = body === undefined ? '' : JSON.stringify(body)
    return { status, headers: { 'content-type': 'application/json' }, text: async () => text }
  }
  private err(status: number, code: string): NetworkResponse {
    return this.json(status, { error: { code, message: 'synthetic fixture error' } })
  }

  private addr(a: { address: string; name?: string }) {
    return { emailAddress: { address: a.address, ...(a.name ? { name: a.name } : {}) } }
  }

  private wire(m: GrMsg): Record<string, unknown> {
    return {
      id: m.id, conversationId: m.conversationId, parentFolderId: m.parentFolderId, subject: m.subject, from: this.addr(m.from),
      toRecipients: m.to.map((a) => this.addr(a)), ccRecipients: m.cc.map((a) => this.addr(a)), bccRecipients: m.bcc.map((a) => this.addr(a)),
      receivedDateTime: new Date(m.received).toISOString().replace('.000Z', 'Z'), isRead: m.isRead, isDraft: m.isDraft,
      flag: { flagStatus: m.flagged ? 'flagged' : 'notFlagged' }, categories: m.categories, internetMessageHeaders: m.headers,
      internetMessageId: m.internetMessageId, body: { contentType: 'text', content: m.body }, bodyPreview: m.body.slice(0, 255), hasAttachments: m.attachments.length > 0,
    }
  }

  /** A page of a collection, with a next link that keeps the request's own query and adds a skip token. */
  private page<T>(items: T[], url: URL, defaultSize: number): NetworkResponse {
    const size = Number(url.searchParams.get('$top') ?? defaultSize)
    const start = Number(url.searchParams.get('$skiptoken') ?? 0)
    const slice = items.slice(start, start + size)
    let next: string | undefined
    if (start + size < items.length) {
      const u = new URL(url.toString())
      u.searchParams.set('$skiptoken', String(start + size))
      next = u.toString()
    }
    return this.json(200, { value: slice, ...(next ? { '@odata.nextLink': next } : {}) })
  }

  private handle(req: NetworkRequest): NetworkResponse {
    this.requests.push(req)
    if (this.failNext) {
      const f = this.failNext
      this.failNext = undefined
      return this.json(f.status, f.body ? JSON.parse(f.body) : { error: { code: 'Forced', message: 'forced' } })
    }
    const auth = req.headers?.authorization ?? ''
    if (!auth.startsWith('Bearer ') || auth.length < 8) return this.err(401, 'InvalidAuthenticationToken')
    if (!req.url.startsWith(`${GRAPH_API_BASE}/`)) return this.err(404, 'ErrorInvalidRequest')
    const url = new URL(req.url)
    const segs = url.pathname.slice(new URL(GRAPH_API_BASE).pathname.length).split('/').filter(Boolean).map(decodeURIComponent)
    const method = req.method ?? 'GET'
    const body = req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {}
    if (segs[0] !== 'me') return this.err(404, 'ErrorInvalidRequest')

    if (segs[1] === 'mailFolders') return this.handleFolders(method, segs.slice(2), url)
    if (segs[1] === 'messages') return this.handleMessages(method, segs.slice(2), url, body)
    return this.err(404, 'ErrorInvalidRequest')
  }

  private folderWire(f: GrFolder) {
    const inF = [...this.msgs.values()].filter((m) => m.parentFolderId === f.id)
    return {
      id: f.id, displayName: f.displayName, parentFolderId: f.parentId ?? 'root', unreadItemCount: inF.filter((m) => !m.isRead).length,
      totalItemCount: inF.length, childFolderCount: this.folders.filter((c) => c.parentId === f.id).length,
    }
  }

  private handleFolders(method: string, segs: string[], url: URL): NetworkResponse {
    if (method !== 'GET') return this.err(405, 'ErrorInvalidRequest')
    if (segs.length === 0) return this.page(this.folders.filter((f) => !f.parentId).map((f) => this.folderWire(f)), url, 10)
    const f = this.resolveFolder(segs[0]!)
    if (!f) return this.err(404, 'ErrorItemNotFound')
    if (segs.length === 1) return this.json(200, this.folderWire(f))
    if (segs[1] === 'childFolders') return this.page(this.folders.filter((c) => c.parentId === f.id).map((c) => this.folderWire(c)), url, 10)
    if (segs[1] === 'messages' && segs[2] === 'delta') return this.delta(f, url)
    if (segs[1] === 'messages' && segs.length === 2) return this.messageList(url, f.id)
    return this.err(404, 'ErrorInvalidRequest')
  }

  private delta(f: GrFolder, url: URL): NetworkResponse {
    const tokenParam = url.searchParams.get('$deltatoken')
    const snap = url.searchParams.get('$snap')
    let since = -1
    if (tokenParam !== null) {
      since = Number(tokenParam)
      if (!Number.isInteger(since) || since < this.floor || since > this.seq) return this.err(410, 'SyncStateNotFound')
    } else if (snap !== null) {
      since = Number(snap) < 0 ? -1 : Number(snap)
    }
    const nowParam = url.searchParams.get('$now')
    const now = nowParam !== null ? Number(nowParam) : this.seq
    let items: Array<Record<string, unknown>>
    if (since < 0) {
      items = [...this.msgs.values()].filter((m) => m.parentFolderId === f.id).sort((a, b) => a.id.localeCompare(b.id)).map((m) => ({ id: m.id }))
    } else {
      const touched = [...new Set(this.log.filter((e) => e.seq > since && e.folder === f.id).map((e) => e.id))].sort()
      items = touched.map((id) => {
        const m = this.msgs.get(id)
        if (!m) return { id, '@removed': { reason: 'deleted' } }
        return m.parentFolderId === f.id ? { id } : { id, '@removed': { reason: 'changed' } }
      })
    }
    const start = Number(url.searchParams.get('$skiptoken') ?? 0)
    const slice = items.slice(start, start + PAGE_SIZE_DELTA)
    const base = `${GRAPH_API_BASE}/me/mailFolders/${encodeURIComponent(f.id)}/messages/delta`
    if (start + PAGE_SIZE_DELTA < items.length) {
      const u = new URL(base)
      if (tokenParam !== null) u.searchParams.set('$deltatoken', tokenParam)
      u.searchParams.set('$snap', String(since))
      u.searchParams.set('$now', String(now))
      u.searchParams.set('$skiptoken', String(start + PAGE_SIZE_DELTA))
      return this.json(200, { value: slice, '@odata.nextLink': u.toString() })
    }
    return this.json(200, { value: slice, '@odata.deltaLink': `${base}?%24deltatoken=${now}` })
  }

  private query(url: URL, folderId?: string): GrMsg[] {
    let all = [...this.msgs.values()].filter((m) => !folderId || m.parentFolderId === folderId)
    const search = url.searchParams.get('$search')
    if (search) {
      const words = search.split('"').join(' ').toLowerCase().split(' ').filter(Boolean)
      all = all.filter((m) => {
        const hay = `${m.subject}\n${m.from.address}\n${m.from.name ?? ''}\n${m.body}`.toLowerCase()
        return words.every((w) => hay.includes(w))
      })
    }
    const filter = url.searchParams.get('$filter')
    if (filter) {
      for (const clause of filter.split(' and ')) {
        if (clause === 'isRead eq false') all = all.filter((m) => !m.isRead)
        else if (clause.startsWith('receivedDateTime ge ')) all = all.filter((m) => m.received >= Date.parse(clause.slice(20)))
        else if (clause.startsWith('receivedDateTime le ')) all = all.filter((m) => m.received <= Date.parse(clause.slice(20)))
        else if (clause.startsWith("conversationId eq '")) {
          const v = clause.slice(19, -1).split("''").join("'")
          all = all.filter((m) => m.conversationId === v)
        } else if (clause.startsWith("internetMessageId eq '")) {
          const v = clause.slice(22, -1).split("''").join("'")
          all = all.filter((m) => m.internetMessageId === v)
        }
      }
    }
    return all.sort((a, b) => b.received - a.received || a.id.localeCompare(b.id))
  }

  private messageList(url: URL, folderId?: string): NetworkResponse {
    const select = url.searchParams.get('$select') ?? ''
    const items = this.query(url, folderId).map((m) => {
      const w = this.wire(m)
      if (!select) return w
      const keep = select.split(',')
      return Object.fromEntries(Object.entries(w).filter(([k]) => keep.includes(k)))
    })
    return this.page(items, url, 10)
  }

  private handleMessages(method: string, segs: string[], url: URL, body: Record<string, unknown>): NetworkResponse {
    if (segs.length === 0) {
      if (method === 'GET') return this.messageList(url)
      if (method === 'POST') return this.createDraft(body, undefined)
      return this.err(405, 'ErrorInvalidRequest')
    }
    const m = this.msgs.get(segs[0]!)
    if (!m) return this.err(404, 'ErrorItemNotFound')
    const action = segs[1]
    if (!action) {
      if (method === 'GET') {
        const select = url.searchParams.get('$select')
        const w = this.wire(m)
        return this.json(200, select ? Object.fromEntries(Object.entries(w).filter(([k]) => select.split(',').includes(k))) : w)
      }
      if (method === 'PATCH') return this.patch(m, body)
      return this.err(405, 'ErrorInvalidRequest')
    }
    if (method === 'GET' && action === 'attachments') {
      return this.page(m.attachments.map((a) => ({ id: a.id, name: a.name, contentType: a.contentType, size: a.size, isInline: a.isInline })), url, 10)
    }
    if (method !== 'POST') return this.err(405, 'ErrorInvalidRequest')
    if (action === 'move') {
      const dest = this.resolveFolder(String(body.destinationId))
      if (!dest) return this.err(404, 'ErrorItemNotFound')
      const old = m.parentFolderId
      m.parentFolderId = dest.id
      this.touch(m.id, old)
      this.touch(m.id, dest.id)
      return this.json(201, this.wire(m))
    }
    if (action === 'permanentDelete') {
      this.msgs.delete(m.id)
      this.touch(m.id, m.parentFolderId)
      return this.json(204, undefined)
    }
    if (action === 'createReply') {
      return this.createDraft({ subject: `RE: ${m.subject}`, toRecipients: [this.addr(m.from)], body: { content: '' } }, m)
    }
    if (action === 'send') {
      if (!m.isDraft) return this.err(400, 'ErrorInvalidRequest')
      if (m.to.length === 0) return this.err(400, 'ErrorInvalidRecipients')
      // The draft is removed and a copy with a new id appears in Sent Items.
      const sent = this.resolveFolder('sentitems')!
      const copy: GrMsg = { ...m, id: `gr-sent-${++this.idSeq}`, parentFolderId: sent.id, isDraft: false, isRead: true }
      this.msgs.delete(m.id)
      this.touch(m.id, m.parentFolderId)
      this.msgs.set(copy.id, copy)
      this.touch(copy.id, sent.id)
      return this.json(202, undefined)
    }
    return this.err(404, 'ErrorInvalidRequest')
  }

  private createDraft(body: Record<string, unknown>, replyTo: GrMsg | undefined): NetworkResponse {
    const id = `gr-draft-${++this.idSeq}`
    const drafts = this.resolveFolder('drafts')!
    const m: GrMsg = {
      id, conversationId: replyTo?.conversationId ?? `conv-${id}`, parentFolderId: drafts.id, subject: '', from: { address: this.ownerAddress }, to: [], cc: [], bcc: [],
      received: Date.UTC(2026, 10, 2, 1, 0, this.idSeq), isRead: true, isDraft: true, flagged: false, categories: [], headers: [],
      internetMessageId: `<${id}@example.org>`, body: '', attachments: [],
    }
    this.msgs.set(id, m)
    this.patch(m, body)
    return this.json(201, this.wire(m))
  }

  private patch(m: GrMsg, body: Record<string, unknown>): NetworkResponse {
    const recips = (v: unknown) => ((v as Array<{ emailAddress: { address: string; name?: string } }>) ?? []).map((r) => r.emailAddress)
    if ('isRead' in body) m.isRead = body.isRead === true
    if ('flag' in body) m.flagged = (body.flag as { flagStatus?: string }).flagStatus === 'flagged'
    if ('categories' in body) m.categories = body.categories as string[]
    if (m.isDraft) {
      if ('subject' in body) m.subject = String(body.subject)
      if ('body' in body) m.body = String((body.body as { content?: string }).content ?? '')
      if ('toRecipients' in body) m.to = recips(body.toRecipients)
      if ('ccRecipients' in body) m.cc = recips(body.ccRecipients)
      if ('bccRecipients' in body) m.bcc = recips(body.bccRecipients)
    }
    this.touch(m.id, m.parentFolderId)
    return this.json(200, this.wire(m))
  }
}
