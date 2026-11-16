import type { Folder, Message, Thread } from './model.js'

/**
 * Local mailbox cache (section 5). The interface serves indexed queries (folder and date, sender, thread, flags),
 * incremental upsert and delete, a windowed list over a sorted view, and a per-account sync-token store.
 * Implementations: the in-memory one below, IndexedDB in the browser, SQLite on the desktop. All of them must pass
 * `CACHE_CONFORMANCE_CHECKS` (cache-conformance.ts). No `node:*` and no DOM imports.
 */

export interface MessageQuery {
  folderId?: string
  /** Exact sender address, compared case-insensitively. */
  sender?: string
  threadId?: string
  read?: boolean
  starred?: boolean
  draft?: boolean
  /** ISO instants: keep messages with date >= since and date < before. */
  since?: string
  before?: string
}

export interface Window {
  /** Zero-based offset into the sorted view (newest first, ties broken by id). */
  offset: number
  limit: number
}

export interface WindowResult<T> {
  items: T[]
  /** Size of the whole filtered view, not just this window. */
  total: number
}

export interface EmailCache {
  upsertFolders(folders: Folder[]): Promise<void>
  upsertThreads(threads: Thread[]): Promise<void>
  upsertMessages(messages: Message[]): Promise<void>
  deleteMessages(ids: string[]): Promise<void>
  deleteThreads(ids: string[]): Promise<void>
  getFolders(accountId: string): Promise<Folder[]>
  getMessage(id: string): Promise<Message | undefined>
  getThread(id: string): Promise<Thread | undefined>
  /** Messages matching the query, newest first, as a window. */
  queryMessages(query: MessageQuery, window: Window): Promise<WindowResult<Message>>
  /** Threads that sit in a folder (or all, when absent), newest activity first, as a window. */
  listThreads(folderId: string | undefined, window: Window): Promise<WindowResult<Thread>>
  getSyncToken(accountId: string): Promise<string | undefined>
  setSyncToken(accountId: string, token: string | undefined): Promise<void>
  /** Drop everything for one account (used when a full resync is required). */
  clearAccount(accountId: string): Promise<void>
}

export type EmailCacheFactory = () => Promise<EmailCache> | EmailCache

const byDateDesc = (a: { id: string; date: string }, b: { id: string; date: string }): number =>
  a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
const threadDesc = (a: Thread, b: Thread): number =>
  a.lastMessageAt < b.lastMessageAt ? 1 : a.lastMessageAt > b.lastMessageAt ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0

function clampWindow(w: Window): Window {
  return { offset: Math.max(0, Math.floor(w.offset)), limit: Math.max(0, Math.floor(w.limit)) }
}

/** Shared by implementations that filter in memory. */
export function matchesMessageQuery(m: Message, q: MessageQuery): boolean {
  if (q.folderId !== undefined && !m.folderIds.includes(q.folderId)) return false
  if (q.threadId !== undefined && m.threadId !== q.threadId) return false
  if (q.sender !== undefined && m.from.address.toLowerCase() !== q.sender.toLowerCase()) return false
  if (q.read !== undefined && m.flags.read !== q.read) return false
  if (q.starred !== undefined && m.flags.starred !== q.starred) return false
  if (q.draft !== undefined && m.flags.draft !== q.draft) return false
  if (q.since !== undefined && m.date < q.since) return false
  if (q.before !== undefined && m.date >= q.before) return false
  return true
}

export class InMemoryEmailCache implements EmailCache {
  private folders = new Map<string, Folder>()
  private threads = new Map<string, Thread>()
  private messages = new Map<string, Message>()
  private tokens = new Map<string, string>()
  /** Per-folder index of message ids, and a lazily sorted copy of the whole message list. */
  private byFolder = new Map<string, Set<string>>()
  private sortedAll: Message[] | undefined
  private sortedByFolder = new Map<string, Message[]>()

  private invalidate(): void {
    this.sortedAll = undefined
    this.sortedByFolder.clear()
  }
  private unindex(m: Message): void {
    for (const f of m.folderIds) this.byFolder.get(f)?.delete(m.id)
  }

  async upsertFolders(folders: Folder[]): Promise<void> {
    for (const f of folders) this.folders.set(f.id, structuredClone(f))
  }
  async upsertThreads(threads: Thread[]): Promise<void> {
    for (const t of threads) this.threads.set(t.id, structuredClone(t))
  }
  async upsertMessages(messages: Message[]): Promise<void> {
    for (const m of messages) {
      const old = this.messages.get(m.id)
      if (old) this.unindex(old)
      const copy = structuredClone(m)
      this.messages.set(m.id, copy)
      for (const f of copy.folderIds) {
        let s = this.byFolder.get(f)
        if (!s) this.byFolder.set(f, (s = new Set()))
        s.add(copy.id)
      }
    }
    this.invalidate()
  }
  async deleteMessages(ids: string[]): Promise<void> {
    for (const id of ids) {
      const old = this.messages.get(id)
      if (!old) continue
      this.unindex(old)
      this.messages.delete(id)
    }
    this.invalidate()
  }
  async deleteThreads(ids: string[]): Promise<void> {
    for (const id of ids) this.threads.delete(id)
  }
  async getFolders(accountId: string): Promise<Folder[]> {
    return [...this.folders.values()].filter((f) => f.accountId === accountId).map((f) => structuredClone(f))
  }
  async getMessage(id: string): Promise<Message | undefined> {
    const m = this.messages.get(id)
    return m && structuredClone(m)
  }
  async getThread(id: string): Promise<Thread | undefined> {
    const t = this.threads.get(id)
    return t && structuredClone(t)
  }

  private sortedView(folderId: string | undefined): Message[] {
    if (folderId === undefined) return (this.sortedAll ??= [...this.messages.values()].sort(byDateDesc))
    let v = this.sortedByFolder.get(folderId)
    if (!v) {
      const ids = this.byFolder.get(folderId) ?? new Set<string>()
      v = [...ids].map((id) => this.messages.get(id)!).sort(byDateDesc)
      this.sortedByFolder.set(folderId, v)
    }
    return v
  }

  async queryMessages(query: MessageQuery, window: Window): Promise<WindowResult<Message>> {
    const { offset, limit } = clampWindow(window)
    const view = this.sortedView(query.folderId)
    const rest = { ...query, folderId: undefined }
    const filtered = view.filter((m) => matchesMessageQuery(m, rest))
    return { items: filtered.slice(offset, offset + limit).map((m) => structuredClone(m)), total: filtered.length }
  }

  async listThreads(folderId: string | undefined, window: Window): Promise<WindowResult<Thread>> {
    const { offset, limit } = clampWindow(window)
    const all = [...this.threads.values()].filter((t) => folderId === undefined || t.folderIds.includes(folderId)).sort(threadDesc)
    return { items: all.slice(offset, offset + limit).map((t) => structuredClone(t)), total: all.length }
  }

  async getSyncToken(accountId: string): Promise<string | undefined> {
    return this.tokens.get(accountId)
  }
  async setSyncToken(accountId: string, token: string | undefined): Promise<void> {
    if (token === undefined) this.tokens.delete(accountId)
    else this.tokens.set(accountId, token)
  }

  async clearAccount(accountId: string): Promise<void> {
    for (const [id, m] of [...this.messages]) {
      if (m.accountId === accountId) {
        this.unindex(m)
        this.messages.delete(id)
      }
    }
    for (const [id, t] of [...this.threads]) if (t.accountId === accountId) this.threads.delete(id)
    for (const [id, f] of [...this.folders]) if (f.accountId === accountId) this.folders.delete(id)
    this.tokens.delete(accountId)
    this.invalidate()
  }
}
