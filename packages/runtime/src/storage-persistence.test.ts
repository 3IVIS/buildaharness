import { describe, it, expect, vi, afterEach } from 'vitest'
import { requestPersistentStorage } from './storage-persistence'

describe('requestPersistentStorage', () => {
  afterEach(() => {
    // @ts-expect-error -- test-only cleanup of a global we stub per test
    delete globalThis.navigator
  })

  it('resolves false when navigator.storage is unavailable (e.g. Node/tests)', async () => {
    expect(await requestPersistentStorage()).toBe(false)
  })

  it('returns true immediately when already persisted, without calling persist()', async () => {
    const persist = vi.fn()
    // @ts-expect-error -- minimal StorageManager stub for this test
    globalThis.navigator = { storage: { persisted: vi.fn().mockResolvedValue(true), persist } }
    expect(await requestPersistentStorage()).toBe(true)
    expect(persist).not.toHaveBeenCalled()
  })

  it('calls persist() and returns its result when not yet persisted', async () => {
    const persist = vi.fn().mockResolvedValue(true)
    // @ts-expect-error -- minimal StorageManager stub for this test
    globalThis.navigator = { storage: { persisted: vi.fn().mockResolvedValue(false), persist } }
    expect(await requestPersistentStorage()).toBe(true)
    expect(persist).toHaveBeenCalledOnce()
  })

  it('swallows errors and resolves false rather than throwing', async () => {
    // @ts-expect-error -- minimal StorageManager stub for this test
    globalThis.navigator = { storage: { persisted: vi.fn().mockRejectedValue(new Error('nope')) } }
    expect(await requestPersistentStorage()).toBe(false)
  })
})
