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

function build(opts: { constraints: string[]; replies: string[]; perTurn?: string[][]; lifted?: number[][]; lasting?: number[][] }) {
  let turnNo = 0
  const inner = createScriptedLLMClient({
    responses: opts.replies,
    classify: () => {
      const constraints = opts.perTurn ? (opts.perTurn[turnNo++] ?? []) : opts.constraints
      const lifted = opts.lifted ? (opts.lifted[turnNo - 1] ?? []) : []
      return { statesConstraint: constraints.length > 0, statedConstraints: constraints, liftedConstraints: lifted, ...(opts.lasting ? { lastingConstraints: opts.lasting[turnNo - 1] ?? [] } : {}) }
    },
  })
  const seen = { judgedConstraints: [] as string[], judged: [] as string[], loopMessages: [] as ChatMessage[][] }
  const client: ILLMClient = {
    callChat: (m: ChatMessage[], o?: ChatOptions) => inner.callChat(m, o),
    callChatSync: (m: ChatMessage[], o?: ChatOptions) => inner.callChatSync(m, o),
    async callChatStructured(messages: ChatMessage[], tools?: ToolDefinition[], options?: ChatOptions): Promise<LLMStructuredResponse> {
      const system = messages.find((x) => x.role === 'system')?.content ?? ''
      if (system.includes(JUDGE_MARKER)) {
        const { constraints, reply } = JSON.parse(messages[messages.length - 1].content) as { constraints: string[]; reply: string }
        seen.judged.push(reply)
        seen.judgedConstraints.push(JSON.stringify(constraints))
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

  it('a constraint stated in an earlier turn still governs a later turn that states none', async () => {
    const { assistant, seen } = build({ constraints: [], perTurn: [['Do not use tabs'], []], replies: [GOOD, BAD, GOOD] })
    expect((await assistant.turn(MESSAGE, { sessionId: 'p1' })).reply).toBe(GOOD)
    const second = await assistant.turn('Now do the same for YAML files.', { sessionId: 'p1' })
    expect(second.reply).toBe(GOOD)
    expect(seen.judged).toEqual([GOOD, BAD, GOOD])
  })

  it('negative control — a different session does not inherit the constraint, and /new-style clearing drops it', async () => {
    const { assistant, seen } = build({ constraints: [], perTurn: [['Do not use tabs'], [], []], replies: [GOOD, BAD, BAD] })
    await assistant.turn(MESSAGE, { sessionId: 'p2' })
    const other = await assistant.turn('Now do the same for YAML files.', { sessionId: 'p3' })
    expect(other.reply).toBe(BAD)
    expect(seen.judged).toEqual([GOOD])
  })

  it('a later message that lifts the constraint stops it being checked', async () => {
    const { assistant, seen } = build({ constraints: [], perTurn: [['Do not use tabs'], []], lifted: [[], [1]], replies: [GOOD, BAD] })
    await assistant.turn(MESSAGE, { sessionId: 'l1' })
    expect((await assistant.turn('Tabs are fine now.', { sessionId: 'l1' })).reply).toBe(BAD)
    expect(seen.judged).toEqual([GOOD])
  })

  it('a rule lifted and restated in the same message stays in force', async () => {
    const { assistant, seen } = build({ constraints: [], perTurn: [['Do not use tabs'], ['Do not use tabs'], []], lifted: [[], [1], []], replies: [GOOD, GOOD, GOOD] })
    await assistant.turn(MESSAGE, { sessionId: 'l2' })
    await assistant.turn('No tabs, to be clear.', { sessionId: 'l2' })
    await assistant.turn('One more.', { sessionId: 'l2' })
    expect(seen.judged).toEqual([GOOD, GOOD, GOOD])
  })

  it('only a rule marked lasting persists; a one-answer rule is checked this turn and then dropped', async () => {
    const { assistant, seen } = build({
      constraints: [], perTurn: [['Do not use tabs', 'Five lines at most'], []], lasting: [[1], []], replies: [GOOD, GOOD],
    })
    await assistant.turn(MESSAGE, { sessionId: 'k1' })
    expect(JSON.parse(seen.judgedConstraints[0])).toEqual(['Do not use tabs', 'Five lines at most'])
    await assistant.turn('Now the YAML one.', { sessionId: 'k1' })
    expect(JSON.parse(seen.judgedConstraints[1])).toEqual(['Do not use tabs'])
  })

  it('negative control — the classifier omits the field: every stated rule persists, as before', async () => {
    const { assistant, seen } = build({ constraints: [], perTurn: [['Do not use tabs', 'Five lines at most'], []], replies: [GOOD, GOOD] })
    await assistant.turn(MESSAGE, { sessionId: 'k2' })
    await assistant.turn('Now the YAML one.', { sessionId: 'k2' })
    expect(JSON.parse(seen.judgedConstraints[1])).toEqual(['Do not use tabs', 'Five lines at most'])
  })

  it('a second violation returns the answer with a note naming the constraint, instead of failing the turn', async () => {
    const { assistant, seen } = build({ constraints: ['Do not use tabs'], replies: [BAD, BAD] })
    const result = await assistant.turn(MESSAGE, { sessionId: 'u1' })
    expect(result.status).toBe('ok')
    expect(result.reply).toContain(BAD)
    expect(result.reply).toContain('may not fully meet a constraint you set')
    expect(result.reply).toContain('- Do not use tabs (indents with a tab)')
    expect(seen.judged).toEqual([BAD, BAD])
  })

  it('negative control — a clean answer carries no note', async () => {
    const { assistant } = build({ constraints: ['Do not use tabs'], replies: [GOOD] })
    const result = await assistant.turn(MESSAGE, { sessionId: 'u2' })
    expect(result.reply).toBe(GOOD)
  })
})
