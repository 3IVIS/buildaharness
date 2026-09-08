import { describe, it, expect } from 'vitest'
import type { ILLMClient, ChatMessage, ToolDefinition, ChatOptions } from '@buildaharness/runtime'
import {
  wrapRecordingClient,
  mergeTranscriptEvents,
  scrubSecrets,
  type TranscriptEvent,
} from './transcript-capture.js'

/** A scripted client: canned replies, records nothing itself, taps onUsage. */
function scriptedClient(): ILLMClient {
  return {
    async *callChat(_messages: ChatMessage[], _options?: ChatOptions) {
      yield 'hello '
      yield 'world'
    },
    async callChatSync(_messages: ChatMessage[], options?: ChatOptions) {
      options?.onUsage?.({ inputTokens: 10, outputTokens: 3, costUsd: 0.001 })
      return 'sync reply'
    },
    async callChatStructured(_messages: ChatMessage[], _tools?: ToolDefinition[], options?: ChatOptions) {
      options?.onUsage?.({ inputTokens: 20, outputTokens: 5 })
      return { content: 'structured reply', toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'a.txt' } }] }
    },
  }
}

describe('wrapRecordingClient', () => {
  it('records a request/response pair per call, in order, and drain() is idempotent', async () => {
    const rec = wrapRecordingClient(scriptedClient(), { model: 'sonnet' })

    const sync = await rec.client.callChatSync([{ role: 'user', content: 'hi' }])
    const structured = await rec.client.callChatStructured([{ role: 'user', content: 'go' }])

    expect(sync).toBe('sync reply')
    expect(structured.content).toBe('structured reply')

    const first = rec.drain()
    const second = rec.drain()
    expect(second).toEqual(first) // idempotent — never clears

    expect(first.map((e) => e.kind)).toEqual(['llm_request', 'llm_response', 'llm_request', 'llm_response'])
    expect(first[0]).toMatchObject({ dir: 'req', model: 'sonnet' })
    expect(first[1]).toMatchObject({ dir: 'res', reply: 'sync reply', usage: { inputTokens: 10, outputTokens: 3 } })
    expect(first[3]).toMatchObject({ reply: 'structured reply', toolCalls: [{ name: 'read_file' }] })
  })

  it('is transparent — streamed chunks and caller onUsage still fire unchanged', async () => {
    const seen: number[] = []
    const rec = wrapRecordingClient(scriptedClient())

    let streamed = ''
    for await (const chunk of rec.client.callChat([{ role: 'user', content: 'x' }])) streamed += chunk
    expect(streamed).toBe('hello world')

    await rec.client.callChatSync([{ role: 'user', content: 'x' }], { onUsage: (u) => seen.push(u.inputTokens) })
    expect(seen).toEqual([10])

    const events = rec.drain()
    expect(events.find((e) => e.kind === 'llm_response' && e.reply === 'hello world')).toBeDefined()
  })

  it('scrubs a planted secret out of both the request and the response', async () => {
    const leaky: ILLMClient = {
      async *callChat() {},
      async callChatSync() {
        return 'the api_key is sk-ant-abcdefghijklmnop12345 do not share'
      },
      async callChatStructured() {
        return { content: '' }
      },
    }
    const rec = wrapRecordingClient(leaky)
    const reply = await rec.client.callChatSync([{ role: 'user', content: 'token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345' }])
    // The wrapped call itself is untouched — only the recording is scrubbed.
    expect(reply).toContain('sk-ant-')

    const events = rec.drain()
    const req = JSON.stringify(events[0])
    const res = JSON.stringify(events[1])
    expect(req).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ')
    expect(res).not.toContain('sk-ant-abcdefghijklmnop')
    expect(res).toContain('[redacted]')
  })
})

describe('scrubSecrets', () => {
  it('redacts common key shapes and keeps ordinary prose', () => {
    expect(scrubSecrets('AKIAIOSFODNN7EXAMPLE')).toBe('[redacted]')
    expect(scrubSecrets('"token": "abcdef0123456789abcdef"')).toContain('[redacted]')
    expect(scrubSecrets('run the migration before deploying')).toBe('run the migration before deploying')
  })
})

describe('mergeTranscriptEvents', () => {
  it('time-orders across streams and is stable for equal timestamps', () => {
    const a: TranscriptEvent[] = [{ t: 3, kind: 'trace' }, { t: 1, kind: 'trace' }]
    const b: TranscriptEvent[] = [{ t: 1, kind: 'debug' }, { t: 2, kind: 'debug' }]
    const merged = mergeTranscriptEvents(a, b)
    expect(merged.map((e) => [e.t, e.kind])).toEqual([
      [1, 'trace'],
      [1, 'debug'],
      [2, 'debug'],
      [3, 'trace'],
    ])
  })
})
