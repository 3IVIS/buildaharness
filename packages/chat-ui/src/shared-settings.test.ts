import { beforeEach, describe, expect, it } from 'vitest'
import { CHAT_KEY, SEEDED_KEY, WRITE_KEY, connectionFromChat, markSettingsShared, seedChatFromWrite, writeConnectionFromChat } from './shared-settings'

const chat = (): Record<string, unknown> | null => JSON.parse(localStorage.getItem(CHAT_KEY) ?? 'null')
beforeEach(() => localStorage.clear())

describe('chat settings → Write', () => {
  it('copies the key and search key when Write has nothing yet', () => {
    localStorage.setItem(CHAT_KEY, JSON.stringify({ llmBackend: 'openai', apiKey: 'sk-1', braveApiKey: 'b-1', proxyUrl: 'https://p' }))
    expect(writeConnectionFromChat()).toMatchObject({ provider: 'openai', apiKey: 'sk-1', searchKey: 'b-1' })
    expect(localStorage.getItem(SEEDED_KEY)).not.toBeNull()
  })
  it('copies a self-hosted model proxy', () => {
    expect(connectionFromChat({ llmBackend: 'proxy', proxyUrl: 'https://m/', authToken: 't' })).toMatchObject({ provider: 'proxy', modelUrl: 'https://m', apiKey: 't' })
  })
  it('copies nothing when the chat page has no connection', () => {
    localStorage.setItem(CHAT_KEY, JSON.stringify({ enableWeb: true }))
    expect(writeConnectionFromChat()).toBeUndefined()
  })
  it('does not fill Write again after it was copied or cleared', () => {
    localStorage.setItem(CHAT_KEY, JSON.stringify({ apiKey: 'sk-1' }))
    markSettingsShared()
    expect(writeConnectionFromChat()).toBeUndefined()
  })
})

describe('page-reading proxy and GitHub token', () => {
  it('chat → Write: copies the page proxy behind a direct provider, and the token', () => {
    expect(connectionFromChat({ llmBackend: 'anthropic', apiKey: 'k', webBackend: 'proxy', proxyUrl: 'https://w/', authToken: 'wt', githubToken: 'gh' })).toMatchObject({ pagesUrl: 'https://w', pagesToken: 'wt', githubToken: 'gh' })
  })
  it('chat → Write: the proxy of a proxy provider is the model proxy, not a page proxy', () => {
    expect(connectionFromChat({ llmBackend: 'proxy', proxyUrl: 'https://m', webBackend: 'proxy' })?.pagesUrl).toBeUndefined()
  })
  it('Write → chat: copies the page proxy and the token', () => {
    localStorage.setItem(WRITE_KEY, JSON.stringify({ provider: 'openai', apiKey: 'k', pagesUrl: 'https://w', pagesToken: 'wt', githubToken: 'gh' }))
    seedChatFromWrite()
    expect(chat()).toMatchObject({ webBackend: 'proxy', proxyUrl: 'https://w', authToken: 'wt', githubToken: 'gh' })
  })
})

describe('Write settings → chat', () => {
  it('copies the connection and keeps the chat page’s other settings', () => {
    localStorage.setItem(WRITE_KEY, JSON.stringify({ provider: 'anthropic', apiKey: 'sk-w', searchKey: 'b-w' }))
    localStorage.setItem(CHAT_KEY, JSON.stringify({ enableWeb: true }))
    seedChatFromWrite()
    expect(chat()).toMatchObject({ enableWeb: true, llmBackend: 'anthropic', apiKey: 'sk-w', braveApiKey: 'b-w' })
  })
  it('never touches a chat page that already has its own connection', () => {
    localStorage.setItem(CHAT_KEY, JSON.stringify({ llmBackend: 'openai', apiKey: 'mine' }))
    localStorage.setItem(WRITE_KEY, JSON.stringify({ provider: 'anthropic', apiKey: 'sk-w' }))
    seedChatFromWrite()
    expect(chat()).toEqual({ llmBackend: 'openai', apiKey: 'mine' })
  })
  it('does nothing when Write has no connection', () => {
    seedChatFromWrite()
    expect(chat()).toBeNull()
  })
})
