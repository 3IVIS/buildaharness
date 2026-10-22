import { describe, it, expect, vi, beforeEach } from 'vitest'

const invokeMock = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }))

const { TauriClaudeCliLLMClient } = await import('./tauri-claude-cli-llm-client.js')

const reply = (text: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ result: text, ...extra })
const user = [{ role: 'user' as const, content: 'hi' }]

beforeEach(() => {
  invokeMock.mockReset()
})

describe('TauriClaudeCliLLMClient (U7 audit: what it shares with ClaudeCliLLMClient)', () => {
  it('builds the prompt with the shared buildClaudePrompt and passes the per-call model to the Rust command', async () => {
    invokeMock.mockResolvedValue(reply('hello'))
    const client = new TauriClaudeCliLLMClient()
    expect(await client.callChatSync([{ role: 'system', content: 'be brief' }, ...user], { model: 'opus' })).toBe('hello')
    expect(invokeMock).toHaveBeenCalledWith('run_claude_prompt', { systemPrompt: 'be brief', prompt: 'hi', model: 'opus', requestId: null })
  })

  it('sends no model when it is empty or blank, so the CLI uses its own default (an empty --model is rejected as unrecognized)', async () => {
    invokeMock.mockResolvedValue(reply('hello'))
    const client = new TauriClaudeCliLLMClient()
    await client.callChatSync(user, { model: '' })
    await client.callChatSync(user, { model: '  ' })
    expect(invokeMock.mock.calls.map((c) => (c[1] as { model: unknown }).model)).toEqual([null, null])
  })

  it('reports usage, with the real cost, through onUsage (shared parseClaudeCliOutput)', async () => {
    invokeMock.mockResolvedValue(reply('x', { usage: { input_tokens: 3, output_tokens: 4 }, total_cost_usd: 0.01 }))
    const onUsage = vi.fn()
    await new TauriClaudeCliLLMClient().callChatSync(user, { onUsage })
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 3, outputTokens: 4, costUsd: 0.01 })
  })

  it('refuses tool calls unless constructed with fileTools', async () => {
    await expect(new TauriClaudeCliLLMClient().callChatStructured(user, [{ name: 't', description: '', inputSchema: {} } as never])).rejects.toThrow(/fileTools/)
  })

  it('surfaces a staged write as the shared __staged_action tool call', async () => {
    const record = { id: 'p1', kind: 'write', path: 'a.txt', content: 'x' }
    invokeMock.mockResolvedValue({ stdout: reply(''), staged_action: JSON.stringify(record) })
    const client = new TauriClaudeCliLLMClient({ fileTools: { workspaceRoot: '/ws' } })
    const out = await client.callChatStructured(user, [{ name: 't', description: '', inputSchema: {} } as never])
    expect(out.toolCalls?.[0]).toMatchObject({ name: '__staged_action', input: { id: 'p1', kind: 'write', path: 'a.txt' } })
    expect(invokeMock).toHaveBeenCalledWith('run_claude_prompt_with_file_tools', expect.objectContaining({ workspaceRoot: '/ws', enableShellTools: false }))
  })
})

describe('TauriClaudeCliLLMClient structured output (gap G1 of U7, fixed in U10)', () => {
  // ClaudeCliLLMClient strips a markdown fence from the content when options.structuredOutput is set; so must this one, or a caller that JSON.parses the content fails on desktop.
  it('strips a ```json fence from structured output', async () => {
    invokeMock.mockResolvedValue(reply('```json\n{"ok":true}\n```'))
    const out = await new TauriClaudeCliLLMClient().callChatStructured(user, undefined, { structuredOutput: true } as never)
    expect(JSON.parse(out.content)).toEqual({ ok: true })
  })

  it('leaves the content alone when structured output was not asked for', async () => {
    invokeMock.mockResolvedValue(reply('```json\n{"ok":true}\n```'))
    const out = await new TauriClaudeCliLLMClient().callChatStructured(user)
    expect(out.content).toContain('```json')
  })
})

describe('TauriClaudeCliLLMClient: Stop', () => {
  it('gives a stoppable call an id and tells the host to end that process when the signal aborts', async () => {
    let finish: (v: string) => void = () => undefined
    invokeMock.mockImplementation((cmd: string) => (cmd === 'run_claude_prompt' ? new Promise<string>((r) => { finish = r }) : Promise.resolve()))
    const stop = new AbortController()
    const run = new TauriClaudeCliLLMClient().callChatSync(user, { signal: stop.signal })
    await Promise.resolve()
    const started = invokeMock.mock.calls.find((c) => c[0] === 'run_claude_prompt')![1] as { requestId: string }
    expect(typeof started.requestId).toBe('string')
    stop.abort()
    expect(invokeMock).toHaveBeenCalledWith('cancel_claude_prompt', { requestId: started.requestId })
    finish(reply('late'))
    await run
  })
  it('does not start a call that is already stopped', async () => {
    const stop = new AbortController()
    stop.abort()
    await expect(new TauriClaudeCliLLMClient().callChatSync(user, { signal: stop.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
