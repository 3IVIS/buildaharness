import { describe, it, expect } from 'vitest'
import { FlowExecutionError, type ChatMessage, type ChatOptions, type ILLMClient, type LLMStructuredResponse, type ToolDefinition } from '@buildaharness/runtime'
import { withSideCallPolicy, SIDE_CALL_TIMEOUT_MS, SIDE_CALL_RETRY_TIMEOUT_MS } from './side-call-policy.js'

const timeout = () => new FlowExecutionError({ nodeId: 'openai-compatible-client', message: 'LLM request timed out after 45s waiting for the model to respond', cause: { timeout: true } })

class ScriptedClient implements ILLMClient {
  calls: { options?: ChatOptions }[] = []
  constructor(private readonly steps: (Error | string)[]) {}
  async *callChat(): AsyncIterable<string> { yield 'chat' }
  async callChatSync(): Promise<string> { return 'sync' }
  async callChatStructured(_m: ChatMessage[], _t?: ToolDefinition[], options?: ChatOptions): Promise<LLMStructuredResponse> {
    this.calls.push({ options })
    const step = this.steps[Math.min(this.calls.length - 1, this.steps.length - 1)]
    if (step instanceof Error) throw step
    return { content: step }
  }
}
const schema = { structuredOutput: { schema: { type: 'object' } } }

describe('side-call policy', () => {
  it('bounds a structured side call at 45 s and passes the answer through', async () => {
    const inner = new ScriptedClient(['{"ok":true}'])
    const out = await withSideCallPolicy(inner).callChatStructured([], undefined, schema)
    expect(out.content).toBe('{"ok":true}')
    expect(inner.calls).toHaveLength(1)
    expect(inner.calls[0].options?.timeoutMs).toBe(SIDE_CALL_TIMEOUT_MS)
  })

  it('asks a call that timed out once more, with the longer bound, and reports the retry', async () => {
    const inner = new ScriptedClient([timeout(), '{"ok":true}'])
    const seen: number[] = []
    const out = await withSideCallPolicy(inner, ({ timeoutMs }) => seen.push(timeoutMs)).callChatStructured([], undefined, schema)
    expect(out.content).toBe('{"ok":true}')
    expect(inner.calls.map((c) => c.options?.timeoutMs)).toEqual([SIDE_CALL_TIMEOUT_MS, SIDE_CALL_RETRY_TIMEOUT_MS])
    expect(seen).toEqual([SIDE_CALL_TIMEOUT_MS])
  })

  it('gives up after exactly two attempts when the retry times out as well', async () => {
    const inner = new ScriptedClient([timeout(), timeout(), '{"ok":true}'])
    await expect(withSideCallPolicy(inner).callChatStructured([], undefined, schema)).rejects.toThrow(/timed out/)
    expect(inner.calls).toHaveLength(2)
  })

  it('does not retry a refusal or any other failure', async () => {
    const inner = new ScriptedClient([new Error('proxy unreachable'), '{"ok":true}'])
    await expect(withSideCallPolicy(inner).callChatStructured([], undefined, schema)).rejects.toThrow('proxy unreachable')
    expect(inner.calls).toHaveLength(1)
  })

  it('leaves main chat and tool-loop calls alone: no added bound, no retry', async () => {
    const inner = new ScriptedClient([timeout(), 'x'])
    await expect(withSideCallPolicy(inner).callChatStructured([], [{ name: 't', description: 'd', input_schema: {} }], {})).rejects.toThrow(/timed out/)
    expect(inner.calls).toHaveLength(1)
    expect(inner.calls[0].options?.timeoutMs).toBeUndefined()
    const wrapped = withSideCallPolicy(inner)
    expect(await wrapped.callChatSync([])).toBe('sync')
    const tokens: string[] = []
    for await (const t of wrapped.callChat([])) tokens.push(t)
    expect(tokens).toEqual(['chat'])
  })

  it("keeps a caller's own bound for the first attempt", async () => {
    const inner = new ScriptedClient([timeout(), '{"ok":true}'])
    await withSideCallPolicy(inner).callChatStructured([], undefined, { ...schema, timeoutMs: 20_000 })
    expect(inner.calls.map((c) => c.options?.timeoutMs)).toEqual([20_000, SIDE_CALL_RETRY_TIMEOUT_MS])
  })
})
