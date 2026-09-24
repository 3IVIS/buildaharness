import { describe, it, expect, vi } from 'vitest'
import { checkApiKeyFormat, cleanApiKey, testApiKey } from './provider-setup.js'

const ANT = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz'
const OAI = 'sk-proj-abcdefghijklmnopqrstuvwxyz'
const OR = 'sk-or-v1-abcdefghijklmnopqrstuvwxyz'

describe('cleanApiKey', () => {
  it('trims whitespace and wrapping quotes', () => {
    expect(cleanApiKey(`  "${ANT}"\n`)).toBe(ANT)
    expect(cleanApiKey(`'${ANT}'`)).toBe(ANT)
  })
})

describe('checkApiKeyFormat', () => {
  it('accepts plausible keys for each provider', () => {
    expect(checkApiKeyFormat('anthropic', ANT)).toBeNull()
    expect(checkApiKeyFormat('openai', OAI)).toBeNull()
    expect(checkApiKeyFormat('openrouter', OR)).toBeNull()
  })
  it('rejects empty, spaced and too-short input', () => {
    expect(checkApiKeyFormat('anthropic', '')).toMatch(/Nothing was pasted/)
    expect(checkApiKeyFormat('anthropic', 'sk-ant- abc')).toMatch(/spaces/)
    expect(checkApiKeyFormat('anthropic', 'sk-ant-abc')).toMatch(/too short/)
  })
  it('names the right provider when a key for another one is pasted', () => {
    expect(checkApiKeyFormat('anthropic', OR)).toMatch(/OpenRouter key/)
    expect(checkApiKeyFormat('openai', ANT)).toMatch(/Anthropic key/)
    expect(checkApiKeyFormat('openrouter', OAI)).toMatch(/start with sk-or-/)
  })
})

describe('testApiKey', () => {
  const respond = (status: number) => vi.fn(async () => new Response('{}', { status })) as unknown as typeof fetch

  it('is valid on 2xx', async () => {
    expect(await testApiKey('anthropic', ANT, respond(200))).toEqual({ status: 'valid' })
  })
  it('is invalid on 401/403', async () => {
    expect((await testApiKey('openai', OAI, respond(401))).status).toBe('invalid')
    expect((await testApiKey('openrouter', OR, respond(403))).status).toBe('invalid')
  })
  it('is unverified (not invalid) on network failure or a 5xx', async () => {
    const boom = vi.fn(async () => { throw new TypeError('Failed to fetch') }) as unknown as typeof fetch
    expect((await testApiKey('anthropic', ANT, boom)).status).toBe('unverified')
    expect((await testApiKey('anthropic', ANT, respond(500))).status).toBe('unverified')
  })
  it('sends provider-appropriate auth', async () => {
    const f = respond(200)
    await testApiKey('anthropic', ANT, f)
    await testApiKey('openai', OAI, f)
    const calls = (f as unknown as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][]
    expect((calls[0][1].headers as Record<string, string>)['x-api-key']).toBe(ANT)
    expect((calls[1][1].headers as Record<string, string>).Authorization).toBe(`Bearer ${OAI}`)
  })
})
