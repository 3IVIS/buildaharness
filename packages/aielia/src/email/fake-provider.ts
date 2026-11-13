import type { Account, Folder, Message, Thread } from './model.js'
import {
  EmailProviderError, type ChangeSet, type DraftInput, type EmailProvider, type MessageChange, type Page, type PageOptions, type SearchQuery,
} from './provider.js'
import { generateSyntheticMailbox, type SyntheticMailbox } from './synthetic-mailbox.js'

const DEFAULT_LIMIT = 50

/** An in-memory EmailProvider over a synthetic mailbox. Sync tokens are change-log positions ("v<n>"). */
export class FakeEmailProvider implements EmailProvider {
  readonly account: Account
  private folders: Folder[]
  private messages = new Map<string, Message>()
  private threads = new Map<string, Thread>()
  private log: Array<{ v: number; change: MessageChange }> = []
  private version = 0
  /** Oldest log position still available; tokens older than this need a full resync. */
  private floor = 0
  private seq = 0

  constructor(mailbox: SyntheticMailbox = generateSyntheticMailbox()) {
    const copy = structuredClone(mailbox)
    this.account = copy.account
    this.folders = copy.folders
    for (const m of copy.messages) this.messages.set(m.id, m)
    for (const t of copy.threads) this.threads.set(t.id, t)
  }

  /** Test hook: forget the change log, as a provider whose history expired would. */
  expireHistory(): void {
    this.floor = this.version + 1
    this.log = []
  }

  /** Test hook: deliver a new inbound message, as if it arrived from outside. */
  deliver(partial: Pick<Message, 'from' | 'subject' | 'textBody'> & { threadId?: string }): Message {
    const id = `new-${++this.seq}`
    const threadId = partial.threadId ?? `thr-${id}`
    const msg: Message = {
      id, accountId: this.account.id, threadId, providerId: `p-${id}`, folderIds: ['fld-inbox'], from: partial.from,
      to: [{ address: this.account.address }], cc: [], subject: partial.subject, date: new Date(Date.UTC(2026, 10, 2, 0, 0, this.seq)).toISOString(),
      headers: { 'message-id': `<${id}@example.com>` }, textBody: partial.textBody, attachments: [], flags: { read: false, starred: false, draft: false },
    }
    this.messages.set(id, msg)
    this.touchThread(threadId, msg)
    this.record({ type: 'upsert', messageId: id })
    return structuredClone(msg)
  }

  async listFolders(): Promise<Folder[]> {
    return structuredClone(this.folders.map((f) => ({ ...f, unreadCount: this.unread(f.id) })))
  }

  async listMessages(folderId: string, opts: PageOptions = {}): Promise<Page<Message>> {
    this.requireFolder(folderId)
    const all = [...this.messages.values()].filter((m) => m.folderIds.includes(folderId)).sort(byDateDesc)
    return page(all, opts)
  }

  async listThreads(folderId: string, opts: PageOptions = {}): Promise<Page<Thread>> {
    this.requireFolder(folderId)
    const all = [...this.threads.values()].filter((t) => t.folderIds.includes(folderId)).sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt) || a.id.localeCompare(b.id))
    return page(all, opts)
  }

  async getMessage(messageId: string): Promise<Message> {
    return structuredClone(this.requireMessage(messageId))
  }

  async getThread(threadId: string): Promise<{ thread: Thread; messages: Message[] }> {
    const thread = this.threads.get(threadId)
    if (!thread) throw new EmailProviderError('not_found', `No thread ${threadId}.`)
    const messages = thread.messageIds.map((id) => this.requireMessage(id)).sort((a, b) => a.date.localeCompare(b.date))
    return structuredClone({ thread, messages })
  }

  async search(q: SearchQuery, opts: PageOptions = {}): Promise<Page<Message>> {
    const text = q.text?.toLowerCase()
    const from = q.from?.toLowerCase()
    const all = [...this.messages.values()].filter((m) => {
      if (q.folderId && !m.folderIds.includes(q.folderId)) return false
      if (q.unreadOnly && m.flags.read) return false
      if (q.after && m.date < q.after) return false
      if (q.before && m.date > q.before) return false
      if (from && !(m.from.address.toLowerCase().includes(from) || (m.from.name ?? '').toLowerCase().includes(from))) return false
      if (text && !`${m.subject}\n${m.from.address}\n${m.from.name ?? ''}\n${m.textBody}`.toLowerCase().includes(text)) return false
      return true
    }).sort(byDateDesc)
    return page(all, opts)
  }

  async move(messageIds: string[], folderId: string): Promise<void> {
    this.requireFolder(folderId)
    this.each(messageIds, (m) => { m.folderIds = [folderId] })
  }

  async label(messageIds: string[], folderId: string, add: boolean): Promise<void> {
    this.requireFolder(folderId)
    this.each(messageIds, (m) => {
      const has = m.folderIds.includes(folderId)
      if (add && !has) m.folderIds = [...m.folderIds, folderId]
      if (!add && has) m.folderIds = m.folderIds.filter((f) => f !== folderId)
    })
  }

  async flag(messageIds: string[], starred: boolean): Promise<void> {
    this.each(messageIds, (m) => { m.flags = { ...m.flags, starred } })
  }

  async markRead(messageIds: string[], read: boolean): Promise<void> {
    this.each(messageIds, (m) => { m.flags = { ...m.flags, read } })
  }

  async createDraft(draft: DraftInput): Promise<Message> {
    if (draft.to.length === 0) throw new EmailProviderError('invalid_argument', 'A draft needs at least one recipient.')
    const id = `draft-${++this.seq}`
    const threadId = draft.threadId ?? `thr-${id}`
    if (draft.threadId && !this.threads.has(draft.threadId)) throw new EmailProviderError('not_found', `No thread ${draft.threadId}.`)
    const msg: Message = {
      id, accountId: this.account.id, threadId, providerId: `p-${id}`, folderIds: ['fld-drafts'], from: { address: this.account.address, name: this.account.displayName },
      to: draft.to, cc: draft.cc ?? [], subject: draft.subject, date: new Date(Date.UTC(2026, 10, 2, 1, 0, this.seq)).toISOString(),
      headers: { 'message-id': `<${id}@example.org>` }, textBody: draft.textBody, attachments: [], flags: { read: true, starred: false, draft: true },
    }
    this.messages.set(id, msg)
    this.touchThread(threadId, msg)
    this.record({ type: 'upsert', messageId: id })
    return structuredClone(msg)
  }

  async send(draftId: string): Promise<Message> {
    const m = this.requireMessage(draftId)
    if (!m.flags.draft) throw new EmailProviderError('invalid_argument', `Message ${draftId} is not a draft.`)
    m.flags = { ...m.flags, draft: false }
    m.folderIds = ['fld-sent']
    this.record({ type: 'upsert', messageId: m.id })
    return structuredClone(m)
  }

  async delete(messageIds: string[]): Promise<void> {
    for (const id of messageIds) this.requireMessage(id)
    for (const id of messageIds) {
      const m = this.messages.get(id)!
      if (m.folderIds.includes('fld-trash')) {
        this.messages.delete(id)
        const t = this.threads.get(m.threadId)
        if (t) {
          t.messageIds = t.messageIds.filter((x) => x !== id)
          if (t.messageIds.length === 0) this.threads.delete(t.id)
          else this.rebuildThread(t)
        }
        this.record({ type: 'delete', messageId: id })
      } else {
        m.folderIds = ['fld-trash']
        this.touchThreadOf(m)
        this.record({ type: 'upsert', messageId: id })
      }
    }
  }

  async listChanges(syncToken?: string): Promise<ChangeSet> {
    const current = `v${this.version}`
    if (syncToken === undefined) return { changes: [], syncToken: current, fullResyncNeeded: false }
    const since = /^v(\d+)$/.exec(syncToken)
    if (!since || Number(since[1]) < this.floor - 1 || Number(since[1]) > this.version) return { changes: [], syncToken: current, fullResyncNeeded: true }
    const from = Number(since[1])
    // Collapse to the last change per message, in log order.
    const last = new Map<string, MessageChange>()
    for (const e of this.log) if (e.v > from) last.set(e.change.messageId, e.change)
    return { changes: [...last.values()], syncToken: current, fullResyncNeeded: false }
  }

  // --- internals ---

  private record(change: MessageChange): void {
    this.version += 1
    this.log.push({ v: this.version, change })
  }

  private each(ids: string[], fn: (m: Message) => void): void {
    for (const id of ids) this.requireMessage(id)
    for (const id of ids) {
      const m = this.messages.get(id)!
      fn(m)
      this.touchThreadOf(m)
      this.record({ type: 'upsert', messageId: id })
    }
  }

  private requireMessage(id: string): Message {
    const m = this.messages.get(id)
    if (!m) throw new EmailProviderError('not_found', `No message ${id}.`)
    return m
  }

  private requireFolder(id: string): void {
    if (!this.folders.some((f) => f.id === id)) throw new EmailProviderError('not_found', `No folder ${id}.`)
  }

  private unread(folderId: string): number {
    let n = 0
    for (const m of this.messages.values()) if (m.folderIds.includes(folderId) && !m.flags.read) n += 1
    return n
  }

  private touchThread(threadId: string, added: Message): void {
    const t = this.threads.get(threadId)
    if (!t) {
      this.threads.set(threadId, {
        id: threadId, accountId: this.account.id, providerId: `p-${threadId}`, subject: added.subject, messageIds: [added.id],
        folderIds: [...added.folderIds], participants: [added.from, ...added.to], lastMessageAt: added.date, unread: !added.flags.read,
      })
      return
    }
    if (!t.messageIds.includes(added.id)) t.messageIds.push(added.id)
    this.rebuildThread(t)
  }

  private touchThreadOf(m: Message): void {
    const t = this.threads.get(m.threadId)
    if (t) this.rebuildThread(t)
  }

  private rebuildThread(t: Thread): void {
    const ms = t.messageIds.map((id) => this.messages.get(id)).filter((m): m is Message => !!m)
    t.folderIds = [...new Set(ms.flatMap((m) => m.folderIds))]
    t.lastMessageAt = ms.map((m) => m.date).sort().at(-1) ?? t.lastMessageAt
    t.unread = ms.some((m) => !m.flags.read)
  }
}

function byDateDesc(a: Message, b: Message): number {
  return b.date.localeCompare(a.date) || a.id.localeCompare(b.id)
}

function page<T>(all: T[], opts: PageOptions): Page<T> {
  const limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT)
  const start = opts.pageToken === undefined ? 0 : Number(opts.pageToken)
  if (!Number.isInteger(start) || start < 0) throw new EmailProviderError('invalid_argument', 'Bad page token.')
  const items = structuredClone(all.slice(start, start + limit))
  const next = start + limit
  return next < all.length ? { items, nextPageToken: String(next) } : { items }
}
