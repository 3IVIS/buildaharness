import { describe, it, expect, vi, afterEach } from 'vitest'
import { FlowExecutionError, type ChatMessage, type ChatOptions, type ILLMClient, type LLMStructuredResponse, type ToolDefinition } from '@buildaharness/runtime'
import { withSideCallPolicy, SIDE_CALL_HEDGE_AFTER_MS, SIDE_CALL_TIMEOUT_MS } from './side-call-policy.js'

const timeout = () => new FlowExecutionError({ nodeId: 'openai-compatible-client', message: 'LLM request timed out after 120s waiting for the model to respond', cause: { timeout: true } })
const schema = { structuredOutput: { schema: { type: 'object' } } }
afterEach(() => { vi.useRealTimers() })

/** Each call is scripted: a value answers after `after` ms, an Error rejects after `after` ms. */
type Step = { after: number; result: string | Error }
class ScriptedClient implements ILLMClient {
  calls: { options?: ChatOptions }[] = []
  constructor(private readonly steps: Step[]) {}
  async *callChat(): AsyncIterable<string> { yield 'chat' }
  async callChatSync(): Promise<string> { return 'sync' }
  callChatStructured(_m: ChatMessage[], _t?: ToolDefinition[], options?: ChatOptions): Promise<LLMStructuredResponse> {
    this.calls.push({ options })
    const step = this.steps[Math.min(this.calls.length - 1, this.steps.length - 1)]
    return new Promise((resolve, reject) => setTimeout(() => (step.result instanceof Error ? reject(step.result) : resolve({ content: step.result })), step.after))
  }
}

describe('side-call policy (hedged side calls)', () => {
  it('answers a quick call once, with no second attempt, and gives it the hard bound', async () => {
    vi.useFakeTimers()
    const inner = new ScriptedClient([{ after: 3_000, result: 'A' }])
    const p = withSideCallPolicy(inner).callChatStructured([], undefined, schema)
    await vi.advanceTimersByTimeAsync(3_000)
    expect((await p).content).toBe('A')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(inner.calls).toHaveLength(1)
    expect(inner.calls[0].options?.timeoutMs).toBe(SIDE_CALL_TIMEOUT_MS)
  })

  it('does not cut off a slow but live answer: the first attempt still wins when it answers before the second', async () => {
    vi.useFakeTimers()
    const inner = new ScriptedClient([{ after: 59_000, result: 'slow-first' }, { after: 40_000, result: 'second' }])
    const hedges: number[] = []
    const p = withSideCallPolicy(inner, { onHedge: ({ afterMs }) => hedges.push(afterMs) }).callChatStructured([], undefined, schema)
    await vi.advanceTimersByTimeAsync(59_000)
    expect((await p).content).toBe('slow-first')
    expect(hedges).toEqual([SIDE_CALL_HEDGE_AFTER_MS])
    expect(inner.calls).toHaveLength(2)
  })

  it('rescues a hung call: the second attempt, started after the hedge delay, answers and wins', async () => {
    vi.useFakeTimers()
    const inner = new ScriptedClient([{ after: 10 * 60_000, result: 'never' }, { after: 8_000, result: 'second' }])
    const p = withSideCallPolicy(inner).callChatStructured([], undefined, schema)
    await vi.advanceTimersByTimeAsync(SIDE_CALL_HEDGE_AFTER_MS + 8_000)
    expect((await p).content).toBe('second')
  })

  it('gives up only when both attempts time out, after exactly two attempts', async () => {
    vi.useFakeTimers()
    const inner = new ScriptedClient([{ after: 120_000, result: timeout() }, { after: 120_000, result: timeout() }, { after: 1, result: 'third' }])
    const p = withSideCallPolicy(inner).callChatStructured([], undefined, schema)
    const caught = p.then(() => 'resolved', (e: Error) => e.message)
    await vi.advanceTimersByTimeAsync(SIDE_CALL_HEDGE_AFTER_MS + 120_000)
    expect(await caught).toMatch(/timed out/)
    expect(inner.calls).toHaveLength(2)
  })

  it('asks again at once when the only attempt times out before the hedge delay', async () => {
    vi.useFakeTimers()
    const inner = new ScriptedClient([{ after: 1_000, result: timeout() }, { after: 2_000, result: 'second' }])
    const hedges: number[] = []
    const p = withSideCallPolicy(inner, { onHedge: ({ afterMs }) => hedges.push(afterMs) }).callChatStructured([], undefined, schema)
    await vi.advanceTimersByTimeAsync(3_000)
    expect((await p).content).toBe('second')
    expect(hedges).toHaveLength(1)
    expect(inner.calls).toHaveLength(2)
  })

  it('returns a refusal or any other failure at once, without a second attempt', async () => {
    vi.useFakeTimers()
    const inner = new ScriptedClient([{ after: 500, result: new Error('proxy unreachable') }, { after: 1, result: 'later' }])
    const p = withSideCallPolicy(inner).callChatStructured([], undefined, schema)
    const caught = p.then(() => 'resolved', (e: Error) => e.message)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await caught).toBe('proxy unreachable')
    expect(inner.calls).toHaveLength(1)
  })

  it('leaves main chat and tool-loop calls alone: no added bound, no second attempt', async () => {
    const inner = new ScriptedClient([{ after: 0, result: 'x' }])
    const wrapped = withSideCallPolicy(inner)
    await wrapped.callChatStructured([], [{ name: 't', description: 'd', input_schema: {} }], {})
    expect(inner.calls).toHaveLength(1)
    expect(inner.calls[0].options?.timeoutMs).toBeUndefined()
    expect(await wrapped.callChatSync([])).toBe('sync')
    const tokens: string[] = []
    for await (const t of wrapped.callChat([])) tokens.push(t)
    expect(tokens).toEqual(['chat'])
  })

  it("keeps a caller's own bound for each attempt", async () => {
    vi.useFakeTimers()
    const inner = new ScriptedClient([{ after: 40_000, result: 'A' }])
    const p = withSideCallPolicy(inner).callChatStructured([], undefined, { ...schema, timeoutMs: 20_000 })
    await vi.advanceTimersByTimeAsync(40_000)
    await p
    expect(inner.calls.every((c) => c.options?.timeoutMs === 20_000)).toBe(true)
  })
})
