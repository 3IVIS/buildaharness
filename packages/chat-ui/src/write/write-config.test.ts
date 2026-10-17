import { afterEach, describe, expect, it } from 'vitest'
import { loadConnection, saveConnection, toAssistantConfig } from './write-config'

afterEach(() => localStorage.clear())

describe('the Write connection', () => {
  it('is stored under its own key, apart from the /try settings, and cleaned on the way in', () => {
    localStorage.setItem('buildaharness.personal-assistant.config', JSON.stringify({ llmBackend: 'openai', apiKey: 'try-key' }))
    expect(loadConnection()).toBeUndefined()
    saveConnection({ provider: 'anthropic', apiKey: ' sk-1 ', pagesUrl: 'https://proxy.test///', searchKey: '  ' })
    expect(loadConnection()).toEqual({ provider: 'anthropic', apiKey: 'sk-1', pagesUrl: 'https://proxy.test', pagesToken: undefined, searchKey: undefined })
    expect(JSON.parse(localStorage.getItem('buildaharness.personal-assistant.config')!)).toEqual({ llmBackend: 'openai', apiKey: 'try-key' })
  })
  it('ignores damaged or incomplete stored data and never saves an incomplete connection', () => {
    localStorage.setItem('aielia-write.connection', '{nope')
    expect(loadConnection()).toBeUndefined()
    localStorage.setItem('aielia-write.connection', JSON.stringify({ provider: 'bogus', apiKey: 'k' }))
    expect(loadConnection()).toBeUndefined()
    saveConnection({ provider: 'openai', apiKey: '' })
    expect(localStorage.getItem('aielia-write.connection')).toBe('{"provider":"bogus","apiKey":"k"}')
  })
  it('turns into a configuration: pages and search only when set up; build settings are defaults the writer overrides', () => {
    const plain = toAssistantConfig({ provider: 'openai', apiKey: 'k' }, {})
    expect(plain).toMatchObject({ llmBackend: 'openai', apiKey: 'k', webBackend: 'direct' })
    const full = toAssistantConfig({ provider: 'anthropic', apiKey: 'k', pagesUrl: 'https://p.test', pagesToken: 't', searchKey: 'b' }, { proxyUrl: 'https://default.test' })
    expect(full).toMatchObject({ webBackend: 'proxy', proxyUrl: 'https://p.test', authToken: 't', braveApiKey: 'b' })
    expect(toAssistantConfig(undefined, { proxyUrl: 'https://default.test' }).proxyUrl).toBe('https://default.test')
  })
})
