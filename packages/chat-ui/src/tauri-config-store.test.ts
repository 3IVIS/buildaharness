import { describe, it, expect, vi, afterEach } from 'vitest'
import type { FsBackend } from '@buildaharness/runtime'
import { FileSystemAdapter } from '@buildaharness/runtime'

const invokeMock = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }))

const { TauriConfigStore } = await import('./tauri-config-store.js')

/** In-memory FsBackend standing in for @tauri-apps/plugin-fs — same style as file-tools.test.ts's makeFakeBackend. */
function makeFakeBackend(): FsBackend {
  const files = new Map<string, string>()
  return {
    async readTextFile(path) {
      return files.get(path)
    },
    async writeTextFile(path, contents) {
      files.set(path, contents)
    },
    async removeFile(path) {
      files.delete(path)
    },
    async mkdir() {
      // no-op — this fake has no directory-existence tracking
    },
    async readDir() {
      return []
    },
  }
}

/** Default: nothing saved in the keychain yet — matches a fresh install. Individual tests override with mockResolvedValueOnce/mockImplementation as needed. */
function invokeDefault(command: string): unknown {
  if (command === 'keychain_get_api_key') return null
  return undefined
}

afterEach(() => {
  vi.clearAllMocks()
  invokeMock.mockImplementation((command: string) => Promise.resolve(invokeDefault(command)))
})
invokeMock.mockImplementation((command: string) => Promise.resolve(invokeDefault(command)))

describe('TauriConfigStore', () => {
  it('load() returns {} (apiKey undefined) when nothing has been saved yet', async () => {
    const store = new TauriConfigStore({ backend: makeFakeBackend(), baseDir: '/data' })
    expect(await store.load()).toEqual({})
    expect(invokeMock).toHaveBeenCalledWith('keychain_get_api_key')
  })

  it('save() then load() round-trips exactly for non-apiKey fields', async () => {
    const store = new TauriConfigStore({ backend: makeFakeBackend(), baseDir: '/data' })
    await store.save({ enableWeb: true, workspaceRoot: '/Users/alice/project' })
    expect(await store.load()).toEqual({ enableWeb: true, workspaceRoot: '/Users/alice/project' })
  })

  it('save() merges onto existing persisted state instead of overwriting unrelated keys', async () => {
    const store = new TauriConfigStore({ backend: makeFakeBackend(), baseDir: '/data' })
    await store.save({ enableWeb: true, model: 'model-a' })
    await store.save({ model: 'model-b' })
    expect(await store.load()).toEqual({ enableWeb: true, model: 'model-b' })
  })

  it('two TauriConfigStore instances over the same backend/baseDir see each other\'s writes', async () => {
    const backend = makeFakeBackend()
    const storeA = new TauriConfigStore({ backend, baseDir: '/data' })
    const storeB = new TauriConfigStore({ backend, baseDir: '/data' })
    await storeA.save({ enableShell: true })
    expect(await storeB.load()).toEqual({ enableShell: true })
  })

  describe('apiKey routes through the OS keychain, not the plaintext file (T7)', () => {
    it('save() with an apiKey patch calls keychain_set_api_key and never writes apiKey into the plaintext file', async () => {
      const backend = makeFakeBackend()
      const store = new TauriConfigStore({ backend, baseDir: '/data' })
      await store.save({ llmBackend: 'anthropic', apiKey: 'sk-real-secret' })

      expect(invokeMock).toHaveBeenCalledWith('keychain_set_api_key', { secret: 'sk-real-secret' })

      // Read the raw persisted file directly — apiKey must not appear in it at all.
      const rawAdapter = new FileSystemAdapter({ backend, baseDir: '/data', namespace: 'config' })
      const persisted = (await rawAdapter.get('settings')) as Record<string, unknown>
      expect(persisted).not.toHaveProperty('apiKey')
      expect(persisted.llmBackend).toBe('anthropic')
    })

    it('load() merges the keychain-sourced apiKey back into the resolved config', async () => {
      invokeMock.mockImplementation((command: string) => {
        if (command === 'keychain_get_api_key') return Promise.resolve('sk-from-keychain')
        return Promise.resolve(undefined)
      })
      const store = new TauriConfigStore({ backend: makeFakeBackend(), baseDir: '/data' })
      expect(await store.load()).toEqual({ apiKey: 'sk-from-keychain' })
    })

    it('save() with apiKey explicitly cleared (undefined) calls keychain_delete_api_key', async () => {
      const store = new TauriConfigStore({ backend: makeFakeBackend(), baseDir: '/data' })
      await store.save({ apiKey: undefined })
      expect(invokeMock).toHaveBeenCalledWith('keychain_delete_api_key')
      expect(invokeMock).not.toHaveBeenCalledWith('keychain_set_api_key', expect.anything())
    })

    it('save() of an unrelated field never touches the keychain', async () => {
      const store = new TauriConfigStore({ backend: makeFakeBackend(), baseDir: '/data' })
      await store.save({ enableWeb: true })
      expect(invokeMock).not.toHaveBeenCalledWith('keychain_set_api_key', expect.anything())
      expect(invokeMock).not.toHaveBeenCalledWith('keychain_delete_api_key')
    })

    it('load() migrates a pre-existing plaintext apiKey into the keychain, strips it from the plaintext file, and sets a one-time notice', async () => {
      const backend = makeFakeBackend()
      // Seed "old install" state directly, bypassing TauriConfigStore.save() (which no longer
      // ever writes apiKey into the plaintext file) — mirrors a real pre-T7 config file on disk.
      const rawAdapter = new FileSystemAdapter({ backend, baseDir: '/data', namespace: 'config' })
      await rawAdapter.set('settings', { llmBackend: 'anthropic', apiKey: 'sk-legacy-plaintext' })

      const store = new TauriConfigStore({ backend, baseDir: '/data' })
      const loaded = await store.load()

      expect(loaded.apiKey).toBe('sk-legacy-plaintext')
      expect(invokeMock).toHaveBeenCalledWith('keychain_set_api_key', { secret: 'sk-legacy-plaintext' })
      expect(store.consumeMigrationNotice()).toBe(true)
      // Consuming clears it — a second load() with nothing left to migrate must not re-report it.
      expect(store.consumeMigrationNotice()).toBe(false)

      const persistedAfter = (await rawAdapter.get('settings')) as Record<string, unknown>
      expect(persistedAfter).not.toHaveProperty('apiKey')
      expect(persistedAfter.llmBackend).toBe('anthropic')
    })

    it('a failed keychain write during migration leaves the plaintext apiKey in place rather than losing it', async () => {
      const backend = makeFakeBackend()
      const rawAdapter = new FileSystemAdapter({ backend, baseDir: '/data', namespace: 'config' })
      await rawAdapter.set('settings', { apiKey: 'sk-legacy-plaintext' })

      invokeMock.mockImplementation((command: string) => {
        if (command === 'keychain_set_api_key') return Promise.reject(new Error('keychain access denied'))
        return Promise.resolve(undefined)
      })

      const store = new TauriConfigStore({ backend, baseDir: '/data' })
      await expect(store.load()).rejects.toThrow('keychain access denied')

      const persistedAfter = (await rawAdapter.get('settings')) as Record<string, unknown>
      expect(persistedAfter.apiKey).toBe('sk-legacy-plaintext')
    })

    it('a keychain error on save() propagates rather than silently falling back to plaintext', async () => {
      invokeMock.mockImplementation((command: string) => {
        if (command === 'keychain_set_api_key') return Promise.reject(new Error('keychain access denied'))
        if (command === 'keychain_get_api_key') return Promise.resolve(null)
        return Promise.resolve(undefined)
      })
      const backend = makeFakeBackend()
      const store = new TauriConfigStore({ backend, baseDir: '/data' })
      await expect(store.save({ apiKey: 'sk-new' })).rejects.toThrow('keychain access denied')

      const rawAdapter = new FileSystemAdapter({ backend, baseDir: '/data', namespace: 'config' })
      const persisted = (await rawAdapter.get('settings')) as Record<string, unknown> | undefined
      expect(persisted?.apiKey).toBeUndefined()
    })
  })
})
