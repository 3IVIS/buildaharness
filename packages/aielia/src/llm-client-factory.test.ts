import { describe, it, expect, vi, afterEach } from 'vitest'
import { LLMClient, AnthropicLLMClient, OpenAICompatibleLLMClient, OPENAI_BASE_URL, OPENAI_DEFAULT_MODEL, OPENROUTER_BASE_URL, OPENROUTER_DEFAULT_MODEL, OPENROUTER_EXTRA_HEADERS, type ILLMClient } from '@buildaharness/runtime'
import { DEFAULT_CONFIG, type AssistantConfig } from './config.js'
import { createLlmClient } from './llm-client-factory.js'

const cfg = (over: Partial<AssistantConfig>): AssistantConfig => ({ ...DEFAULT_CONFIG, apiKey: 'k', proxyUrl: 'http://proxy.test', authToken: 't', ...over })

/** Records the one request a client makes through the injected fetch, then fails it so nothing needs a real response. */
async function firstRequest(client: ILLMClient): Promise<{ url: string; init: RequestInit }> {
  const fetchSpy = (client as unknown as { fetchImpl: ReturnType<typeof vi.fn> }).fetchImpl
  await client.callChatSync([{ role: 'user', content: 'hi' }]).catch(() => undefined)
  const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
  return { url, init }
}

afterEach(() => { vi.restoreAllMocks() })

describe('createLlmClient', () => {
  const claudeCli = (): ILLMClient | undefined => undefined

  it('builds the proxy client with the proxy URL and passes fetchImpl through', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('stop'))
    const client = createLlmClient(cfg({ llmBackend: 'proxy' }), { fetchImpl, claudeCli })
    expect(client).toBeInstanceOf(LLMClient)
    expect((await firstRequest(client)).url).toContain('http://proxy.test')
  })

  it('builds the anthropic client and passes fetchImpl through', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('stop'))
    const client = createLlmClient(cfg({ llmBackend: 'anthropic' }), { fetchImpl, claudeCli })
    expect(client).toBeInstanceOf(AnthropicLLMClient)
    expect((await firstRequest(client)).url).toContain('anthropic.com')
  })

  it('builds the openai client with its base URL and default model', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('stop'))
    const client = createLlmClient(cfg({ llmBackend: 'openai' }), { fetchImpl, claudeCli })
    expect(client).toBeInstanceOf(OpenAICompatibleLLMClient)
    const { url, init } = await firstRequest(client)
    expect(url).toBe(`${OPENAI_BASE_URL}/chat/completions`)
    expect(JSON.parse(String(init.body)).model).toBe(OPENAI_DEFAULT_MODEL)
  })

  it('builds the openrouter client with its base URL, default model and extra headers', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('stop'))
    const client = createLlmClient(cfg({ llmBackend: 'openrouter' }), { fetchImpl, claudeCli })
    const { url, init } = await firstRequest(client)
    expect(url).toBe(`${OPENROUTER_BASE_URL}/chat/completions`)
    expect(JSON.parse(String(init.body)).model).toBe(OPENROUTER_DEFAULT_MODEL)
    expect(init.headers).toMatchObject(OPENROUTER_EXTRA_HEADERS)
  })

  it("returns the surface's own client for claude-cli", () => {
    const own = {} as ILLMClient
    expect(createLlmClient(cfg({ llmBackend: 'claude-cli' }), { claudeCli: () => own })).toBe(own)
  })

  it('falls back to the proxy, with a warning, when the surface has no claude-cli client', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const client = createLlmClient(cfg({ llmBackend: 'claude-cli' }), { claudeCli })
    expect(client).toBeInstanceOf(LLMClient)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('falling back to "proxy"'))
  })
})
