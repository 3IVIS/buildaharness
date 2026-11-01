import { describe, expect, it, vi } from 'vitest'
import { CHAT_DATABASES, deleteChatData } from './delete-chat-data'

describe('deleteChatData', () => {
  it('deletes the chat databases and the listed keys, and nothing else', async () => {
    const asked: string[] = []
    const factory = { deleteDatabase: (n: string) => { asked.push(n); const r: { onsuccess?: () => void } = {}; setTimeout(() => r.onsuccess?.(), 0); return r } } as unknown as IDBFactory
    const storage = { removeItem: vi.fn() }
    await deleteChatData({ localKeys: ['a', 'b'], storage, factory })
    expect(asked.sort()).toEqual([...CHAT_DATABASES].sort())
    expect(asked.some((n) => n.includes('write'))).toBe(false)
    expect(storage.removeItem.mock.calls.map((c) => c[0])).toEqual(['a', 'b'])
  })
  it('does not wait forever on a blocked database, and survives unavailable storage', async () => {
    const factory = { deleteDatabase: () => { const r: { onblocked?: () => void } = {}; setTimeout(() => r.onblocked?.(), 0); return r } } as unknown as IDBFactory
    const storage = { removeItem: () => { throw new Error('denied') } }
    await expect(deleteChatData({ localKeys: ['a'], storage, factory, timeoutMs: 10 })).resolves.toBeUndefined()
  })
})
