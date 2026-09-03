import { describe, it, expect, vi, afterEach } from 'vitest'
import { ANTHROPIC_DEFAULT_MODEL, OPENAI_DEFAULT_MODEL, OPENROUTER_DEFAULT_MODEL } from './model-defaults'
import { AnthropicLLMClient } from './anthropic-client'
import { LLMClient } from './llm-client'

/**
 * F1 (adoption plan): the per-provider default model ids are current-generation, and every
 * client that falls back to one actually sends the exported constant. scripts/check-model-defaults.mjs
 * is the source-scanning half of this guard; these are the behavioural half.
 */
describe('model-defaults', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('exports no dated / previous-generation model id', () => {
    for (const id of [ANTHROPIC_DEFAULT_MODEL, OPENAI_DEFAULT_MODEL, OPENROUTER_DEFAULT_MODEL]) {
      expect(id).not.toMatch(/claude-[123]-|claude-2|gpt-[34]|gpt-4o|-20\d{2}(?:\d{2})?$/)
    }
  })

  it('ANTHROPIC_DEFAULT_MODEL is a Claude Sonnet 5-generation id', () => {
    expect(ANTHROPIC_DEFAULT_MODEL).toBe('claude-sonnet-5')
  })

  it('AnthropicLLMClient sends ANTHROPIC_DEFAULT_MODEL when no model is given (structured path)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
    vi.stubGlobal('fetch', mockFetch)

    await new AnthropicLLMClient({ apiKey: 'k' }).callChatStructured([{ role: 'user', content: 'hi' }])

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string)
    expect(body.model).toBe(ANTHROPIC_DEFAULT_MODEL)
  })

  it('LLMClient (proxy) sends ANTHROPIC_DEFAULT_MODEL when no model is given', async () => {
    const encoder = new TextEncoder()
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(encoder.encode('data: [DONE]\n'))
            c.close()
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      )
    )
    vi.stubGlobal('fetch', mockFetch)

    const client = new LLMClient({ proxyUrl: 'http://localhost:8787', authToken: 't' })
    for await (const _ of client.callChat([{ role: 'user', content: 'hi' }])) {
      // consume
    }

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string)
    expect(body.model).toBe(ANTHROPIC_DEFAULT_MODEL)
  })
})
