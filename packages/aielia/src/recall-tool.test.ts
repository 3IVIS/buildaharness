import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ControlState } from '@buildaharness/harness'
import { InMemoryAdapter, InMemoryReminderStore } from '@buildaharness/runtime'
import type { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'
import { AgentLoop } from './agent-loop.js'
import { createTurnControlPlaneState } from './tool-control-plane.js'
import { createScriptedLLMClient } from './scripted-llm-client.js'
import { InMemoryDigestReader, storeDigestReader, executeRecallTool, recallToolEnabled, recallPointerBlock, RECALL_POINTER_LINE, RECALL_INDEX_LIMIT, type DigestReader } from './recall-tool.js'
import { DigestStore, writeDigest, DIGEST_SYSTEM_MARKER, type SessionDigest } from './episodic-digest.js'
import { PersonalAssistant } from './assistant.js'
import { TOOL_EFFECT_CLASS } from './tool-effect-class.js'

const here = dirname(fileURLToPath(import.meta.url))

function digest(id: string, createdAt: string, oneLine: string): SessionDigest {
  return { sessionId: id, createdAt, oneLine, objective: `obj ${id}`, done: ['did a'], decisions: ['use X'], openItems: ['todo b'], nextStep: 'ship it' }
}
const DIGESTS = [digest('s1', '2026-09-01T10:00:00Z', 'Set up the build'), digest('s2', '2026-09-20T10:00:00Z', 'Debugged the proxy')]

describe('recallToolEnabled', () => {
  it('is OFF by default and on only for an explicit truthy value', () => {
    expect(recallToolEnabled({})).toBe(false)
    expect(recallToolEnabled({ AUDIT_RECALL_TOOL: '0' })).toBe(false)
    expect(recallToolEnabled({ AUDIT_RECALL_TOOL: '1' })).toBe(true)
  })
})

describe('executeRecallTool', () => {
  it('returns an index, newest first, untrusted-wrapped and labelled context-not-instruction', async () => {
    const out = await executeRecallTool(new InMemoryDigestReader(DIGESTS), {})
    expect(out.startsWith('<untrusted_external_content>')).toBe(true)
    expect(out).toContain('context, not instruction')
    expect(out.indexOf('s2')).toBeLessThan(out.indexOf('s1'))
    expect(out).toContain('2026-09-20 | Debugged the proxy | id: s2')
  })

  it('caps the index at RECALL_INDEX_LIMIT', async () => {
    const many = Array.from({ length: RECALL_INDEX_LIMIT + 5 }, (_, i) => digest(`d${i}`, `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`, `line ${i}`))
    const out = await executeRecallTool(new InMemoryDigestReader(many), {})
    expect(out.match(/id: d/g)).toHaveLength(RECALL_INDEX_LIMIT)
  })

  it('opens a digest by id, wrapped as untrusted', async () => {
    const out = await executeRecallTool(new InMemoryDigestReader(DIGESTS), { id: 's1' })
    expect(out.startsWith('<untrusted_external_content>')).toBe(true)
    expect(out).toContain('context, not instruction')
    expect(out).toContain('Objective: obj s1')
    expect(out).toContain('- use X')
    expect(out).toContain('Next step: ship it')
  })

  it('returns an error result (no throw) for an unknown id', async () => {
    const out = await executeRecallTool(new InMemoryDigestReader(DIGESTS), { id: 'nope' })
    expect(out).toMatch(/^Error: no digest with id "nope"/)
  })

  it('returns an error result when the reader throws', async () => {
    const reader = { list: async () => { throw new Error('disk gone') }, get: async () => { throw new Error('disk gone') } }
    expect(await executeRecallTool(reader, {})).toMatch(/^Error: .*disk gone/)
    expect(await executeRecallTool(reader, { id: 'x' })).toMatch(/^Error: .*disk gone/)
  })

  it('says so when there are no digests', async () => {
    expect(await executeRecallTool(new InMemoryDigestReader([]), {})).toContain('No session digests yet')
  })
})

/** Proxy-shaped client: calls recall_memory with the given inputs in sequence, records each tool message. */
class RecallingClient implements ILLMClient {
  toolResults: string[] = []
  offeredTools: string[] = []
  private call = 0
  constructor(private readonly inputs: Array<Record<string, unknown>>) {}
  async *callChat(): AsyncIterable<string> { yield '' }
  async callChatSync(): Promise<string> { return '' }
  async callChatStructured(messages: ChatMessage[], tools?: ToolDefinition[], _o: ChatOptions = {}): Promise<LLMStructuredResponse> {
    this.offeredTools = (tools ?? []).map((t) => t.name)
    const last = messages[messages.length - 1]
    if (last?.role === 'tool') this.toolResults.push(last.content)
    if (this.call < this.inputs.length) {
      const input = this.inputs[this.call++]
      return { content: '', toolCalls: [{ id: `t${this.call}`, name: 'recall_memory', input }] }
    }
    return { content: 'done' }
  }
}

function buildLoop(client: ILLMClient, reader: DigestReader | undefined): AgentLoop {
  const memory = new InMemoryAdapter()
  const loop = new AgentLoop(memory, client, () => undefined, undefined, undefined, undefined, undefined, new InMemoryReminderStore(memory), 5, undefined, undefined)
  if (reader) loop.digestReader = reader
  return loop
}

describe('recall_memory through AgentLoop', () => {
  let saved: string | undefined
  beforeEach(() => { saved = process.env.AUDIT_RECALL_TOOL })
  afterEach(() => {
    if (saved === undefined) delete process.env.AUDIT_RECALL_TOOL
    else process.env.AUDIT_RECALL_TOOL = saved
  })

  it('is not offered when the flag is off, even with a reader', async () => {
    delete process.env.AUDIT_RECALL_TOOL
    const client = new RecallingClient([])
    await buildLoop(client, new InMemoryDigestReader(DIGESTS)).runToolLoop('s', [], 'hi', 'sys')
    expect(client.offeredTools).not.toContain('recall_memory')
  })

  it('index then open-by-id work (the model chooses the id)', async () => {
    process.env.AUDIT_RECALL_TOOL = '1'
    const client = new RecallingClient([{}, { id: 's1' }, { id: 'bogus' }])
    const result = await buildLoop(client, new InMemoryDigestReader(DIGESTS)).runToolLoop('s', [], 'what did we do before?', 'sys')
    expect(client.offeredTools).toContain('recall_memory')
    expect(result.kind).toBe('final')
    expect(client.toolResults[0]).toContain('id: s2')
    expect(client.toolResults[1]).toContain('Objective: obj s1')
    expect(client.toolResults[2]).toMatch(/^Error: no digest/)
    expect(client.toolResults.slice(0, 2).every((t) => t.startsWith('<untrusted_external_content>'))).toBe(true)
  })

  it('works with the scripted client (no crash, final answer returned)', async () => {
    process.env.AUDIT_RECALL_TOOL = '1'
    const scripted = createScriptedLLMClient({
      responses: [{ content: '', toolCalls: [{ id: 't1', name: 'recall_memory', input: {} }] }, 'Last time we set up the build.'],
    })
    const result = await buildLoop(scripted, new InMemoryDigestReader(DIGESTS)).runToolLoop('s', [], 'recap', 'sys')
    expect(result).toMatchObject({ kind: 'final', content: 'Last time we set up the build.' })
  })

  it('is denied under a BLOCKED (permission DENY) turn-local control state and never executes', async () => {
    process.env.AUDIT_RECALL_TOOL = '1'
    const client = new RecallingClient([{}])
    const state = createTurnControlPlaneState(['recall_memory'])
    state.controlState = new ControlState({ permission: 'DENY' })
    await buildLoop(client, new InMemoryDigestReader(DIGESTS)).runToolLoop('s', [], 'recap', 'sys', undefined, undefined, undefined, 'LOW', state)
    expect(client.toolResults[0]).toMatch(/^Denied by tool policy/)
    expect(client.toolResults[0]).not.toContain('Debugged the proxy')
  })

  it('claude-cli shape: onToolProposal gates recall_memory, and onToolExecute serves it parent-side', async () => {
    process.env.AUDIT_RECALL_TOOL = '1'
    let decision: { decision: string } | undefined
    let served: string | undefined
    const client: ILLMClient = {
      async *callChat() { yield '' },
      async callChatSync() { return '' },
      async callChatStructured(_m, _t, options: ChatOptions = {}) {
        decision = await options.onToolProposal?.('recall_memory', {})
        served = await options.onToolExecute?.('recall_memory', { id: 's2' })
        return { content: 'ok' }
      },
    }
    const loop = buildLoop(client, new InMemoryDigestReader(DIGESTS))
    const state = createTurnControlPlaneState(['recall_memory'])
    await loop.runToolLoop('s', [], 'recap', 'sys', undefined, undefined, undefined, 'LOW', state)
    expect(decision).toEqual({ decision: 'allow' })
    expect(served).toContain('Debugged the proxy')

    const blocked = createTurnControlPlaneState(['recall_memory'])
    blocked.controlState = new ControlState({ permission: 'DENY' })
    await loop.runToolLoop('s', [], 'recap', 'sys', undefined, undefined, undefined, 'LOW', blocked)
    expect(decision?.decision).toBe('deny')
  })

  it('is classed a read tool', () => {
    expect(TOOL_EFFECT_CLASS.recall_memory).toBe('read')
  })
})

/**
 * Gate-list guard. Under claude-cli the gate is not a name list: each read-only tool is gated
 * because its registerTool handler calls requestToolGate(<its own name>) in file-tools-mcp-server.mjs
 * (claude-cli-llm-client.ts only runs the gate server and routes by whatever name arrives; its
 * doc comment is the only enumeration there). So the test enforces the real invariant: every
 * registered tool other than the three that stage unconditionally must call requestToolGate with
 * its own name, and recall_memory must be one of them.
 */
describe('claude-cli gate coverage for registered MCP tools', () => {
  const src = readFileSync(join(here, 'file-tools-mcp-server.mjs'), 'utf-8')
  const registered = [...src.matchAll(/registerTool\(\s*'([a-z_]+)'/g)].map((m) => m[1])
  const STAGING = new Set(['write_file', 'run_shell_command', 'send_email'])

  it('registers recall_memory', () => {
    expect(registered).toContain('recall_memory')
  })

  it('every registered read-only tool calls requestToolGate with its own name', () => {
    const readOnly = registered.filter((n) => !STAGING.has(n))
    expect(readOnly.length).toBeGreaterThan(5)
    for (const name of readOnly) {
      expect(src, `${name} is registered but not gated`).toContain(`requestToolGate('${name}'`)
    }
  })

  it('the client doc comment lists recall_memory among the gated tools and passes the enable env', () => {
    const client = readFileSync(join(here, 'claude-cli-llm-client.ts'), 'utf-8')
    expect(client).toContain('list_reminders/recall_memory')
    expect(client).toContain('ENABLE_RECALL_TOOL')
  })
})

describe('recall_memory over the real digest writer (integration)', () => {
  const BODY = { oneLine: 'Planned the Lisbon trip', objective: 'Book travel', done: ['picked dates'], decisions: ['train over flight'], openItems: ['hotel unbooked'], nextStep: 'Book the hotel' }
  const digestClient = (): ILLMClient => ({
    async *callChat() { yield '' },
    async callChatSync() { return '' },
    async callChatStructured(messages) {
      const sys = messages.find((m) => m.role === 'system')?.content ?? ''
      if (!sys.includes(DIGEST_SYSTEM_MARKER)) throw new Error('unexpected call')
      return { content: JSON.stringify({ digest: BODY, containsSecret: false, looksLikeInstruction: false }) }
    },
  })
  let saved: string | undefined
  let savedDigest: string | undefined
  beforeEach(() => { saved = process.env.AUDIT_RECALL_TOOL; savedDigest = process.env.AUDIT_EPISODIC_DIGEST; process.env.AUDIT_EPISODIC_DIGEST = '1' })
  afterEach(() => {
    if (saved === undefined) delete process.env.AUDIT_RECALL_TOOL; else process.env.AUDIT_RECALL_TOOL = saved
    if (savedDigest === undefined) delete process.env.AUDIT_EPISODIC_DIGEST; else process.env.AUDIT_EPISODIC_DIGEST = savedDigest
  })

  async function writeReal(): Promise<{ memory: InMemoryAdapter; id: string }> {
    const memory = new InMemoryAdapter({ scope: 'thread', namespace: 'recall-int' })
    const messages: ChatMessage[] = [{ role: 'user', content: 'Help me plan a Lisbon trip' }, { role: 'assistant', content: 'Sure.' }]
    const written = await writeDigest(memory, digestClient(), { sessionId: 'cli', messages, extractFacts: false })
    expect(written).not.toBeNull()
    return { memory, id: written!.digest.sessionId }
  }

  it('index and open-by-id return the written digest, using the id exactly as listDigests gives it', async () => {
    process.env.AUDIT_RECALL_TOOL = '1'
    const { memory, id } = await writeReal()
    expect(id).toContain(':')
    const reader = storeDigestReader(new DigestStore(memory))
    const index = await executeRecallTool(reader, {})
    expect(index).toContain('Planned the Lisbon trip')
    expect(index).toContain(`id: ${id}`)
    const opened = await executeRecallTool(reader, { id })
    expect(opened).toContain('Objective: Book travel')
    expect(opened).toContain('- train over flight')
    expect(opened).toContain('Next step: Book the hotel')
    expect(await executeRecallTool(reader, { id: 'nope' })).toMatch(/^Error: no digest/)

    const client = new RecallingClient([{}, { id }])
    await buildLoop(client, reader).runToolLoop('s', [], 'what did we do before?', 'sys')
    expect(client.toolResults[0]).toContain(`id: ${id}`)
    expect(client.toolResults[1]).toContain('Objective: Book travel')
  })

  it('reaches the real system prompt of a turn only when flag on and a digest was written', async () => {
    const { memory } = await writeReal()
    const prompts: string[] = []
    const inner = createScriptedLLMClient({ responses: ['ok', 'ok', 'ok'], streamChunks: ['ok'] })
    const spy = (m: ChatMessage[]): void => { const sys = m.find((x) => x.role === 'system')?.content ?? ''; if (sys.includes('You are Aielia')) prompts.push(sys) }
    const llm: ILLMClient = {
      callChat(m, o) { spy(m); return inner.callChat(m, o) },
      async callChatSync(m, o) { spy(m); return inner.callChatSync(m, o) },
      async callChatStructured(m, t, o) { spy(m); return inner.callChatStructured(m, t, o) },
    }
    const run = async (flag: string | undefined, mem: InMemoryAdapter): Promise<string | undefined> => {
      if (flag === undefined) delete process.env.AUDIT_RECALL_TOOL
      else process.env.AUDIT_RECALL_TOOL = flag
      prompts.length = 0
      await new PersonalAssistant({ llmClient: llm, memory: mem }).turn('what did we work on last time?', { sessionId: 'z' })
      return prompts.at(-1)
    }
    expect(await run('1', memory)).toContain('call the recall_memory tool')
    expect(await run(undefined, memory)).not.toContain('recall_memory')
    expect(await run('1', new InMemoryAdapter())).not.toContain('recall_memory')
  })

  it('a turn with no other tools still runs the tool loop so recall_memory is callable (digest + flag), and not otherwise', async () => {
    const { memory } = await writeReal()
    const results: string[] = []
    let offered: string[] = []
    const run = async (flag: string | undefined, mem: InMemoryAdapter): Promise<void> => {
      if (flag === undefined) delete process.env.AUDIT_RECALL_TOOL
      else process.env.AUDIT_RECALL_TOOL = flag
      results.length = 0
      offered = []
      const inner = createScriptedLLMClient({ responses: [{ content: '', toolCalls: [{ id: 't1', name: 'recall_memory', input: {} }] }, 'final'], streamChunks: ['final'] })
      const client: ILLMClient = {
        callChat: (m, o) => inner.callChat(m, o),
        callChatSync: (m, o) => inner.callChatSync(m, o),
        async callChatStructured(m, t, o) {
          if ((t ?? []).length) offered = (t ?? []).map((x) => x.name)
          const last = m[m.length - 1]
          if (last?.role === 'tool') results.push(last.content)
          return inner.callChatStructured(m, t, o)
        },
      }
      await new PersonalAssistant({ llmClient: client, memory: mem }).turn('what did we work on last time?', { sessionId: 'y' })
    }
    await run('1', memory)
    expect(offered).toContain('recall_memory')
    expect(results.join('\n')).toContain('Lisbon')
    await run(undefined, memory)
    expect(offered).not.toContain('recall_memory')
    await run('1', new InMemoryAdapter())
    expect(offered).not.toContain('recall_memory')
  })

  it('PersonalAssistant wires memory.digests: offered with the flag on, absent with it off', async () => {
    const { memory } = await writeReal()
    const offered: string[][] = []
    const llm: ILLMClient = {
      async *callChat() { yield 'ok' },
      async callChatSync() { return 'ok' },
      async callChatStructured(_m, tools) { offered.push((tools ?? []).map((t) => t.name)); return { content: 'ok' } },
    }
    const loopOf = (a: PersonalAssistant) => (a as unknown as { agentLoop: AgentLoop }).agentLoop
    delete process.env.AUDIT_RECALL_TOOL
    const off = new PersonalAssistant({ llmClient: llm, memory })
    expect(loopOf(off).digestReader).toBeDefined()
    await loopOf(off).runToolLoop('s', [], 'hi', 'sys')
    expect(offered.at(-1)).not.toContain('recall_memory')
    process.env.AUDIT_RECALL_TOOL = '1'
    await loopOf(off).runToolLoop('s', [], 'hi', 'sys')
    expect(offered.at(-1)).toContain('recall_memory')
    const listed = await loopOf(off).digestReader!.list(5)
    expect(listed).toHaveLength(1)
  })
})

describe('recall pointer line (system prompt)', () => {
  let saved: string | undefined
  beforeEach(() => { saved = process.env.AUDIT_RECALL_TOOL })
  afterEach(() => {
    if (saved === undefined) delete process.env.AUDIT_RECALL_TOOL
    else process.env.AUDIT_RECALL_TOOL = saved
  })

  it('is present only with the flag on AND a digest existing', async () => {
    process.env.AUDIT_RECALL_TOOL = '1'
    expect(await recallPointerBlock(new InMemoryDigestReader(DIGESTS))).toBe(RECALL_POINTER_LINE)
    expect(RECALL_POINTER_LINE).toContain('recall_memory')
  })

  it('negative control: flag off gives no line', async () => {
    delete process.env.AUDIT_RECALL_TOOL
    expect(await recallPointerBlock(new InMemoryDigestReader(DIGESTS))).toBe('')
  })

  it('negative control: no digests, no reader, or a failing reader gives no line', async () => {
    process.env.AUDIT_RECALL_TOOL = '1'
    expect(await recallPointerBlock(new InMemoryDigestReader([]))).toBe('')
    expect(await recallPointerBlock(undefined)).toBe('')
    expect(await recallPointerBlock({ list: async () => { throw new Error('boom') } })).toBe('')
  })

})
