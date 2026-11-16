import type { EmailCache, MessageQuery, Window, WindowResult } from './cache.js'
import type { Folder, Message, Thread } from './model.js'

/**
 * `EmailCache` over the desktop app's Rust SQLite commands (`mail_cache_*`, packages/desktop/src-tauri/src/mail_cache.rs).
 * It takes the Tauri `invoke` as a parameter, so this module has no Tauri or DOM import and the conformance suite runs
 * it against a fake `invoke` backed by the in-memory cache. Arguments use camelCase keys; Tauri maps them to the
 * snake_case parameters of the Rust commands. Records pass through unchanged: the page never sends or receives a token.
 */
export type CacheInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

const MAX_BATCH = 500

export class TauriSqliteEmailCache implements EmailCache {
  constructor(private readonly invoke: CacheInvoke) {}

  /** Large upserts go in batches so one command never carries tens of thousands of records. */
  private async batched<T>(command: string, items: T[]): Promise<void> {
    for (let i = 0; i < items.length; i += MAX_BATCH) await this.invoke<void>(command, { items: items.slice(i, i + MAX_BATCH) })
  }

  upsertFolders(folders: Folder[]): Promise<void> {
    return this.batched('mail_cache_upsert_folders', folders)
  }
  upsertThreads(threads: Thread[]): Promise<void> {
    return this.batched('mail_cache_upsert_threads', threads)
  }
  upsertMessages(messages: Message[]): Promise<void> {
    return this.batched('mail_cache_upsert_messages', messages)
  }
  async deleteMessages(ids: string[]): Promise<void> {
    for (let i = 0; i < ids.length; i += MAX_BATCH) await this.invoke<void>('mail_cache_delete_messages', { ids: ids.slice(i, i + MAX_BATCH) })
  }
  async deleteThreads(ids: string[]): Promise<void> {
    for (let i = 0; i < ids.length; i += MAX_BATCH) await this.invoke<void>('mail_cache_delete_threads', { ids: ids.slice(i, i + MAX_BATCH) })
  }
  getFolders(accountId: string): Promise<Folder[]> {
    return this.invoke<Folder[]>('mail_cache_get_folders', { accountId })
  }
  async getMessage(id: string): Promise<Message | undefined> {
    return (await this.invoke<Message | null>('mail_cache_get_message', { id })) ?? undefined
  }
  async getThread(id: string): Promise<Thread | undefined> {
    return (await this.invoke<Thread | null>('mail_cache_get_thread', { id })) ?? undefined
  }
  queryMessages(query: MessageQuery, window: Window): Promise<WindowResult<Message>> {
    return this.invoke<WindowResult<Message>>('mail_cache_query_messages', { query, ...clamp(window) })
  }
  listThreads(folderId: string | undefined, window: Window): Promise<WindowResult<Thread>> {
    return this.invoke<WindowResult<Thread>>('mail_cache_list_threads', { folderId: folderId ?? null, ...clamp(window) })
  }
  async getSyncToken(accountId: string): Promise<string | undefined> {
    return (await this.invoke<string | null>('mail_cache_get_sync_token', { accountId })) ?? undefined
  }
  setSyncToken(accountId: string, token: string | undefined): Promise<void> {
    return this.invoke<void>('mail_cache_set_sync_token', { accountId, token: token ?? null })
  }
  clearAccount(accountId: string): Promise<void> {
    return this.invoke<void>('mail_cache_clear_account', { accountId })
  }
}

function clamp(w: Window): Window {
  return { offset: Math.max(0, Math.floor(w.offset)), limit: Math.max(0, Math.floor(w.limit)) }
}
