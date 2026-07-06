import { describe, it, expect, beforeEach, vi } from 'vitest'
import { BrowserConfigStore } from './browser-config-store'

describe('BrowserConfigStore', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('load() returns {} when nothing has been saved yet', async () => {
    const store = new BrowserConfigStore()
    expect(await store.load()).toEqual({})
  })

  it('save() then load() round-trips exactly', async () => {
    const store = new BrowserConfigStore()
    await store.save({ enableWeb: true, searchBackend: 'brave', braveApiKey: 'k' })
    expect(await store.load()).toEqual({ enableWeb: true, searchBackend: 'brave', braveApiKey: 'k' })
  })

  it('save() merges onto existing persisted state instead of overwriting unrelated keys', async () => {
    const store = new BrowserConfigStore()
    await store.save({ enableWeb: true, model: 'model-a' })
    await store.save({ model: 'model-b' })
    expect(await store.load()).toEqual({ enableWeb: true, model: 'model-b' })
  })

  it('a corrupt persisted value falls back to {} without throwing', async () => {
    localStorage.setItem('buildaharness.personal-assistant.config', '{ not valid json')
    const store = new BrowserConfigStore()
    expect(await store.load()).toEqual({})
  })

  it('a thrown localStorage.getItem is caught and load() falls back to {}', async () => {
    const store = new BrowserConfigStore()
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })
    expect(await store.load()).toEqual({})
    spy.mockRestore()
  })

  it('a thrown localStorage.setItem is caught and save() does not throw', async () => {
    const store = new BrowserConfigStore()
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })
    await expect(store.save({ enableWeb: true })).resolves.toBeUndefined()
    spy.mockRestore()
  })
})
