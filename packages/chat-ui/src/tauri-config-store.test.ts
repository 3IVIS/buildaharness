import { describe, it, expect } from 'vitest'
import type { FsBackend } from '@buildaharness/runtime'
import { TauriConfigStore } from './tauri-config-store'

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

describe('TauriConfigStore', () => {
  it('load() returns {} when nothing has been saved yet', async () => {
    const store = new TauriConfigStore({ backend: makeFakeBackend(), baseDir: '/data' })
    expect(await store.load()).toEqual({})
  })

  it('save() then load() round-trips exactly', async () => {
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
})
