import type { EmailCache, MessageQuery, Window, WindowResult } from './cache.js'
import { matchesMessageQuery } from './cache.js'
import type { Folder, Message, Thread } from './model.js'

/**
 * IndexedDB implementation of `EmailCache` with real indexes (the runtime's key-value `MemoryAdapter` cannot serve
 * indexed queries). It takes an `IDBFactory` instead of reaching for the `indexedDB` global, so this module has no DOM
 * imports and runs on `fake-indexeddb` in tests; the browser passes `globalThis.indexedDB`.
 *
 * Index keys are arrays `[scope, inverted date, id]`. The date is inverted character by character, so an ascending
 * walk of an index yields newest first with ties broken by ascending id, exactly the order of the cache contract.
 * Derived index fields live under keys starting with `_` and are stripped on read.
 */

const DB_VERSION = 1
const MESSAGES = 'messages'
const THREADS = 'threads'
const FOLDERS = 'folders'
const TOKENS = 'tokens'

/** Inverts a string so that ascending order of the result is descending order of the input (prefix rule included). */
export function invertForSort(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) out += String.fromCharCode(0xffff - s.charCodeAt(i))
  return out + '￿'
}

type Row<T> = T & Record<string, unknown>

function indexFields(m: Message): Record<string, unknown> {
  const inv = invertForSort(m.date)
  return {
    _all: [inv, m.id],
    _folder: m.folderIds.map((f) => [f, inv, m.id]),
    _thread: [m.threadId, inv, m.id],
    _sender: [m.from.address.toLowerCase(), inv, m.id],
  }
}
function threadIndexFields(t: Thread): Record<string, unknown> {
  const inv = invertForSort(t.lastMessageAt)
  return { _all: [inv, t.id], _folder: t.folderIds.map((f) => [f, inv, t.id]) }
}
function strip<T>(row: Row<T> | undefined): T | undefined {
  if (!row) return undefined
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) if (!k.startsWith('_')) out[k] = v
  return out as T
}

const req = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'))
  })

/** Key range covering every `[scope, ...]` entry. */
function scopeRange(scope: string | undefined): IDBKeyRange | undefined {
  if (scope === undefined) return undefined
  return IDBKeyRange.bound([scope], [scope, '￿￿', '￿￿'])
}

export class IndexedDbEmailCache implements EmailCache {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(factory: IDBFactory, name: string): Promise<IndexedDbEmailCache> {
    const open = factory.open(name, DB_VERSION)
    open.onupgradeneeded = () => {
      const db = open.result
      const messages = db.createObjectStore(MESSAGES, { keyPath: 'id' })
      messages.createIndex('account', 'accountId')
      messages.createIndex('all', '_all')
      messages.createIndex('folder', '_folder', { multiEntry: true })
      messages.createIndex('thread', '_thread')
      messages.createIndex('sender', '_sender')
      const threads = db.createObjectStore(THREADS, { keyPath: 'id' })
      threads.createIndex('account', 'accountId')
      threads.createIndex('all', '_all')
      threads.createIndex('folder', '_folder', { multiEntry: true })
      const folders = db.createObjectStore(FOLDERS, { keyPath: 'id' })
      folders.createIndex('account', 'accountId')
      db.createObjectStore(TOKENS)
    }
    return new IndexedDbEmailCache(await req(open))
  }

  close(): void {
    this.db.close()
  }

  private async putAll<T extends { id: string }>(store: string, rows: T[], derive?: (r: T) => Record<string, unknown>): Promise<void> {
    if (rows.length === 0) return
    const tx = this.db.transaction(store, 'readwrite')
    const os = tx.objectStore(store)
    for (const r of rows) os.put(derive ? { ...r, ...derive(r) } : { ...r })
    await done(tx)
  }
  private async deleteAll(store: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return
    const tx = this.db.transaction(store, 'readwrite')
    const os = tx.objectStore(store)
    for (const id of ids) os.delete(id)
    await done(tx)
  }

  upsertFolders(folders: Folder[]): Promise<void> {
    return this.putAll(FOLDERS, folders)
  }
  upsertThreads(threads: Thread[]): Promise<void> {
    return this.putAll(THREADS, threads, threadIndexFields)
  }
  upsertMessages(messages: Message[]): Promise<void> {
    return this.putAll(MESSAGES, messages, indexFields)
  }
  deleteMessages(ids: string[]): Promise<void> {
    return this.deleteAll(MESSAGES, ids)
  }
  deleteThreads(ids: string[]): Promise<void> {
    return this.deleteAll(THREADS, ids)
  }
  async getFolders(accountId: string): Promise<Folder[]> {
    const rows = await req(this.db.transaction(FOLDERS).objectStore(FOLDERS).index('account').getAll(accountId))
    return rows.map((r) => strip<Folder>(r)!)
  }
  async getMessage(id: string): Promise<Message | undefined> {
    return strip<Message>(await req(this.db.transaction(MESSAGES).objectStore(MESSAGES).get(id)))
  }
  async getThread(id: string): Promise<Thread | undefined> {
    return strip<Thread>(await req(this.db.transaction(THREADS).objectStore(THREADS).get(id)))
  }

  /** Walks one index range newest first; `accept` filters rows. Returns the window and the size of the filtered view. */
  private async windowed<T>(
    store: string,
    indexName: string,
    range: IDBKeyRange | undefined,
    window: Window,
    accept: ((row: T) => boolean) | undefined,
  ): Promise<WindowResult<T>> {
    const offset = Math.max(0, Math.floor(window.offset))
    const limit = Math.max(0, Math.floor(window.limit))
    const os = this.db.transaction(store).objectStore(store)
    const index = os.index(indexName)
    if (!accept) {
      // No residual filter: the index answers the count and the primary keys of the window, then only that
      // window's rows are read. (Bulk reads, not cursor stepping: stepping is O(n) per step on fake-indexeddb.)
      const total = await req(index.count(range))
      if (limit === 0 || offset >= total) return { items: [], total }
      const keys = (await req(index.getAllKeys(range, offset + limit))).slice(offset)
      const rows = await Promise.all(keys.map((k) => req(os.get(k))))
      return { items: rows.map((r) => strip<T>(r as Row<T>)!), total }
    }
    // Residual filters (flags, date range, a second field): read the range in one bulk call and filter in memory.
    const all = (await req(index.getAll(range))) as Row<T>[]
    const items: T[] = []
    let total = 0
    for (const raw of all) {
      const row = strip<T>(raw)!
      if (!accept(row)) continue
      if (total >= offset && items.length < limit) items.push(row)
      total++
    }
    return { items, total }
  }

  queryMessages(query: MessageQuery, window: Window): Promise<WindowResult<Message>> {
    // Pick the most selective index; every other condition is a residual filter over that range.
    let indexName = 'all'
    let scope: string | undefined
    let rest: MessageQuery = query
    if (query.folderId !== undefined) {
      indexName = 'folder'
      scope = query.folderId
      rest = { ...query, folderId: undefined }
    } else if (query.threadId !== undefined) {
      indexName = 'thread'
      scope = query.threadId
      rest = { ...query, threadId: undefined }
    } else if (query.sender !== undefined) {
      indexName = 'sender'
      scope = query.sender.toLowerCase()
      rest = { ...query, sender: undefined }
    }
    const residual = Object.values(rest).some((v) => v !== undefined)
    return this.windowed<Message>(MESSAGES, indexName, scopeRange(scope), window, residual ? (m) => matchesMessageQuery(m, rest) : undefined)
  }

  listThreads(folderId: string | undefined, window: Window): Promise<WindowResult<Thread>> {
    return this.windowed<Thread>(THREADS, folderId === undefined ? 'all' : 'folder', scopeRange(folderId), window, undefined)
  }

  async getSyncToken(accountId: string): Promise<string | undefined> {
    return (await req(this.db.transaction(TOKENS).objectStore(TOKENS).get(accountId))) as string | undefined
  }
  async setSyncToken(accountId: string, token: string | undefined): Promise<void> {
    const tx = this.db.transaction(TOKENS, 'readwrite')
    if (token === undefined) tx.objectStore(TOKENS).delete(accountId)
    else tx.objectStore(TOKENS).put(token, accountId)
    await done(tx)
  }

  async clearAccount(accountId: string): Promise<void> {
    const tx = this.db.transaction([MESSAGES, THREADS, FOLDERS, TOKENS], 'readwrite')
    for (const name of [MESSAGES, THREADS, FOLDERS]) {
      const index = tx.objectStore(name).index('account')
      const c = index.openKeyCursor(IDBKeyRange.only(accountId))
      c.onsuccess = () => {
        const cur = c.result
        if (!cur) return
        tx.objectStore(name).delete(cur.primaryKey)
        cur.continue()
      }
    }
    tx.objectStore(TOKENS).delete(accountId)
    await done(tx)
  }
}
