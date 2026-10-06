import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeConfigStore } from './node-config-store.js'

describe('NodeConfigStore', () => {
  let dir: string | undefined

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = undefined
  })

  async function makeStore(): Promise<{ store: NodeConfigStore; path: string }> {
    dir = await mkdtemp(join(tmpdir(), 'node-config-store-test-'))
    const path = join(dir, 'nested', 'config.json')
    return { store: new NodeConfigStore(path), path }
  }

  it('load() returns {} when the file does not exist yet', async () => {
    const { store } = await makeStore()
    expect(await store.load()).toEqual({})
  })

  it('save() then load() round-trips exactly, creating parent directories as needed', async () => {
    const { store } = await makeStore()
    await store.save({ enableWeb: true, braveApiKey: 'k' })
    expect(await store.load()).toEqual({ enableWeb: true, braveApiKey: 'k' })
  })

  it('save() merges onto existing persisted state instead of overwriting unrelated keys', async () => {
    const { store } = await makeStore()
    await store.save({ enableWeb: true, model: 'model-a' })
    await store.save({ model: 'model-b' })
    expect(await store.load()).toEqual({ enableWeb: true, model: 'model-b' })
  })

  it('setting a key to undefined in a patch removes it from the persisted file', async () => {
    const { store } = await makeStore()
    await store.save({ enableWeb: true, model: 'model-a' })
    await store.save({ model: undefined })
    expect(await store.load()).toEqual({ enableWeb: true })
  })

  it('writes the file owner-only (it holds API keys) and tightens a previously world-readable one', async () => {
    const { store, path } = await makeStore()
    await store.save({ apiKey: 'sk-secret' })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    await writeFile(path, '{"apiKey":"sk-old"}', { mode: 0o644 })
    await store.save({ model: 'm' })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('a persisted file holding a non-object JSON value falls back to {}', async () => {
    const { store, path } = await makeStore()
    await store.save({ model: 'm' })
    await writeFile(path, 'null')
    expect(await store.load()).toEqual({})
    await writeFile(path, '[1,2]')
    expect(await store.load()).toEqual({})
  })

  it('a corrupt persisted file falls back to {} without throwing', async () => {
    const { store, path } = await makeStore()
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, '{ not valid json', 'utf-8')
    expect(await store.load()).toEqual({})
  })

  it('serializes concurrent save() calls instead of racing on the read-modify-write', async () => {
    const { store } = await makeStore()
    await Promise.all([
      store.save({ model: 'a' }),
      store.save({ enableWeb: true }),
      store.save({ braveApiKey: 'k' }),
    ])
    expect(await store.load()).toEqual({ model: 'a', enableWeb: true, braveApiKey: 'k' })
  })

  it('writes through a temp file that is renamed into place, leaving no temp file behind', async () => {
    const { store, path } = await makeStore()
    await store.save({ enableWeb: true })
    const { readdir } = await import('node:fs/promises')
    const files = await readdir(join(path, '..'))
    expect(files).toEqual(['config.json'])
    expect(JSON.parse(await readFile(path, 'utf-8'))).toEqual({ enableWeb: true })
  })
})
