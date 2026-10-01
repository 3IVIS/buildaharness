import { describe, it, expect, afterEach } from 'vitest'
import type { ChatMessage, ChatOptions, FsBackend, ILLMClient, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'
import { PersonalAssistant } from './assistant.js'
import { createScriptedLLMClient } from './scripted-llm-client.js'

// A constraint the user states in a turn reaches the harness (classifier statedConstraints), the semantic judge checks the
// finished answer, and a violation sends the answer back ONCE with the violated constraint in front of the proposer.

const JUDGE_MARKER = "You judge whether an assistant's reply violates constraints"
const BAD = 'Indent with a tab.'
const GOOD = 'Indent with two spaces.'
const MESSAGE = 'Write me a one-line indentation guide. Do not use tabs.'

function backend(): FsBackend {
  return {
    async readTextFile() { return undefined },
    async writeTextFile() {},
    async removeFile() {},
    async mkdir() {},
    async readDir() { return [] },
  }
}

function build(opts: { constraints: string[]; replies: string[] }) {
  const inner = createScriptedLLMClient({
    responses: opts.replies,
    classify: () => ({ statesConstraint: opts.constraints.length > 0, statedConstraints: opts.constraints }),
  })
  const seen = { judged: [] as string[], loopMessages: [] as ChatMessage[][] }
  const client: ILLMClient = {
    callChat: (m: ChatMessage[], o?: ChatOptions) => inner.callChat(m, o),
    callChatSync: (m: ChatMessage[], o?: ChatOptions) => inner.callChatSync(m, o),
    async callChatStructured(messages: ChatMessage[], tools?: ToolDefinition[], options?: ChatOptions): Promise<LLMStructuredResponse> {
      const system = messages.find((x) => x.role === 'system')?.content ?? ''
      if (system.includes(JUDGE_MARKER)) {
        const { constraints, reply } = JSON.parse(messages[messages.length - 1].content) as { constraints: string[]; reply: string }
        seen.judged.push(reply)
        return { content: JSON.stringify({ violations: reply.includes('tab.') ? [{ constraint: constraints[0], reason: 'indents with a tab' }] : [] }) }
      }
      if (tools && tools.length > 0) seen.loopMessages.push(messages.map((m) => ({ ...m })))
      return inner.callChatStructured(messages, tools, options)
    },
  } as ILLMClient
  return { assistant: new PersonalAssistant({ llmClient: client, fileTools: { backend: backend(), workspaceRoot: '/ws' } }), seen }
}

describe('stated constraint through a real turn', () => {
  afterEach(() => { delete process.env.AUDIT_SEMANTIC_CONSTRAINT_CHECK })

  it('a violating first answer is sent back once, with the constraint named; the second answer is the reply', async () => {
    const { assistant, seen } = build({ constraints: ['Do not use tabs'], replies: [BAD, GOOD] })
    const result = await assistant.turn(MESSAGE, { sessionId: 'c1' })
    expect(result.status).toBe('ok')
    expect(result.reply).toBe(GOOD)
    expect(seen.judged).toEqual([BAD, GOOD])
    const last = seen.loopMessages[seen.loopMessages.length - 1]
    expect(last[last.length - 1].content).toContain('Do not use tabs')
  })

  it('a clean first answer: the judge runs once and nothing is revised', async () => {
    const { assistant, seen } = build({ constraints: ['Do not use tabs'], replies: [GOOD, BAD] })
    const result = await assistant.turn(MESSAGE, { sessionId: 'c2' })
    expect(result.reply).toBe(GOOD)
    expect(seen.judged).toEqual([GOOD])
  })

  it('negative control — the classifier states no constraint: the judge never runs, so the violating answer goes out', async () => {
    const { assistant, seen } = build({ constraints: [], replies: [BAD, GOOD] })
    const result = await assistant.turn(MESSAGE, { sessionId: 'c3' })
    expect(result.reply).toBe(BAD)
    expect(seen.judged).toEqual([])
  })

  it('AUDIT_SEMANTIC_CONSTRAINT_CHECK=0: the constraint is not fed to the harness (the lexical word match must not start failing turns)', async () => {
    process.env.AUDIT_SEMANTIC_CONSTRAINT_CHECK = '0'
    const { assistant, seen } = build({ constraints: ['Do not use tabs'], replies: [BAD, GOOD] })
    const result = await assistant.turn(MESSAGE, { sessionId: 'c4' })
    expect(result.status).toBe('ok')
    expect(result.reply).toBe(BAD)
    expect(seen.judged).toEqual([])
  })
})
