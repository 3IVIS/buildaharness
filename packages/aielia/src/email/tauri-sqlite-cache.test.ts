import { describe, it, expect } from 'vitest'
import { InMemoryEmailCache } from './cache.js'
import { TauriSqliteEmailCache, type CacheInvoke } from './tauri-sqlite-cache.js'
import { CACHE_CONFORMANCE_CHECKS, conformanceMessage } from './cache-conformance.js'

/** A fake `invoke` that behaves like the Rust commands, backed by the in-memory cache and a JSON round trip (as IPC does). */
function fakeInvoke(calls: Array<{ command: string; args: Record<string, unknown> }> = []): CacheInvoke {
  const cache = new InMemoryEmailCache()
  const wire = (v: unknown): any => (v === undefined ? null : JSON.parse(JSON.stringify(v)))
  return async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    calls.push({ command, args: JSON.parse(JSON.stringify(args)) })
    const a = JSON.parse(JSON.stringify(args)) as Record<string, any>
    switch (command) {
      case 'mail_cache_upsert_folders': return wire(await cache.upsertFolders(a.items))
      case 'mail_cache_upsert_threads': return wire(await cache.upsertThreads(a.items))
      case 'mail_cache_upsert_messages': return wire(await cache.upsertMessages(a.items))
      case 'mail_cache_delete_messages': return wire(await cache.deleteMessages(a.ids))
      case 'mail_cache_delete_threads': return wire(await cache.deleteThreads(a.ids))
      case 'mail_cache_get_folders': return wire(await cache.getFolders(a.accountId))
      case 'mail_cache_get_message': return wire(await cache.getMessage(a.id))
      case 'mail_cache_get_thread': return wire(await cache.getThread(a.id))
      case 'mail_cache_query_messages': return wire(await cache.queryMessages(a.query, { offset: a.offset, limit: a.limit }))
      case 'mail_cache_list_threads': return wire(await cache.listThreads(a.folderId ?? undefined, { offset: a.offset, limit: a.limit }))
      case 'mail_cache_get_sync_token': return wire(await cache.getSyncToken(a.accountId))
      case 'mail_cache_set_sync_token': return wire(await cache.setSyncToken(a.accountId, a.token ?? undefined))
      case 'mail_cache_clear_account': return wire(await cache.clearAccount(a.accountId))
      default: throw new Error(`unknown command ${command}`)
    }
  }
}

describe('TauriSqliteEmailCache conformance (fake invoke)', () => {
  for (const check of CACHE_CONFORMANCE_CHECKS) {
    it(check.name, async () => {
      await check.run(() => new TauriSqliteEmailCache(fakeInvoke()))
    }, 60_000)
  }
})

describe('TauriSqliteEmailCache specifics', () => {
  it('sends upserts in batches and clamps windows; missing records read as undefined', async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> }> = []
    const c = new TauriSqliteEmailCache(fakeInvoke(calls))
    await c.upsertMessages(Array.from({ length: 1200 }, (_, i) => conformanceMessage(i + 1)))
    expect(calls.filter((x) => x.command === 'mail_cache_upsert_messages').map((x) => (x.args.items as unknown[]).length)).toEqual([500, 500, 200])
    await c.queryMessages({}, { offset: -3, limit: 2.7 })
    expect(calls.at(-1)?.args).toMatchObject({ offset: 0, limit: 2 })
    expect(await c.getMessage('nope')).toBeUndefined()
    expect(await c.getThread('nope')).toBeUndefined()
    expect(await c.getSyncToken('nobody')).toBeUndefined()
  })
  it('passes errors from Rust through', async () => {
    const c = new TauriSqliteEmailCache(async () => {
      throw new Error('cache error: disk full')
    })
    await expect(c.upsertMessages([conformanceMessage(1)])).rejects.toThrow('disk full')
  })
})
