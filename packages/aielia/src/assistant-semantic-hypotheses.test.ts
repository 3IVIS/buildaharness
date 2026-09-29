import { describe, it, expect, afterEach } from 'vitest'
import type { ChatMessage, ChatOptions, FsBackend, ILLMClient, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'
import { PersonalAssistant } from './assistant.js'
import { createScriptedLLMClient } from './scripted-llm-client.js'

// AUDIT_SEMANTIC_HYPOTHESES end to end through a real turn: the classifier's isUnderdetermined gates one proposal
// call, the harness adds the explanations to its active set, and the proposer is shown them before it answers.

const PROPOSE_MARKER = 'You propose competing explanations for an underdetermined request'
const JUDGE_MARKER = 'You decide which explanations a set of new observations rules out'
const PROPOSALS = JSON.stringify({
  hypotheses: [
    { explanation: 'Soft-deleted rows are exported but hidden on the dashboard', predicted_observations: ['rows with deleted_at set'], separating_check: 'count deleted rows' },
    { explanation: 'The dashboard refreshed before late rows arrived', predicted_observations: ['rows newer than the refresh'], separating_check: 'compare refresh time to max(created_at)' },
  ],
})
const QUESTION = 'Our nightly export wrote 4,212 rows but the dashboard shows 3,980. Why do they differ?'

function backend(): FsBackend {
  const files = new Map<string, string>([['/ws/notes.md', 'nothing relevant']])
  return {
    async readTextFile(path) { return files.get(path) },
    async writeTextFile(path, contents) { files.set(path, contents) },
    async removeFile(path) { files.delete(path) },
    async mkdir() {},
    async readDir() { return [] },
  }
}

function build(opts: { underdetermined: boolean; tools?: boolean }) {
  const inner = createScriptedLLMClient({
    responses: ['It could be soft-deleted rows or a stale refresh; here is how to tell.'],
    classify: () => ({ isUnderdetermined: opts.underdetermined }),
    sideResponses: [[PROPOSE_MARKER, PROPOSALS], [JUDGE_MARKER, '{"contradicted":[]}']],
  })
  const seen = { propose: 0, judge: 0, loopMessages: [] as ChatMessage[][], draftSystems: [] as string[] }
  const client: ILLMClient = {
    callChat: (m: ChatMessage[], o?: ChatOptions) => {
      seen.draftSystems.push(m.find((x) => x.role === 'system')?.content ?? '')
      return inner.callChat(m, o)
    },
    callChatSync: (m: ChatMessage[], o?: ChatOptions) => inner.callChatSync(m, o),
    async callChatStructured(messages: ChatMessage[], tools?: ToolDefinition[], options?: ChatOptions): Promise<LLMStructuredResponse> {
      const system = messages.find((x) => x.role === 'system')?.content ?? ''
      if (system.includes(PROPOSE_MARKER)) seen.propose++
      else if (system.includes(JUDGE_MARKER)) seen.judge++
      else if (tools && tools.length > 0) seen.loopMessages.push(messages.map((m) => ({ ...m })))
      return inner.callChatStructured(messages, tools, options)
    },
  } as ILLMClient
  const assistant = new PersonalAssistant({ llmClient: client, ...(opts.tools === false ? {} : { fileTools: { backend: backend(), workspaceRoot: '/ws' } }) })
  return { assistant, seen }
}

const contextMessage = (messages: ChatMessage[]) => messages.find((m) => m.role === 'user' && m.content.includes('can be explained several ways'))

describe('semantic hypotheses through a real turn', () => {
  afterEach(() => { delete process.env.AUDIT_SEMANTIC_HYPOTHESES })

  it('flag on + underdetermined: one proposal call, and the proposer sees the competing explanations before answering', async () => {
    process.env.AUDIT_SEMANTIC_HYPOTHESES = '1'
    const { assistant, seen } = build({ underdetermined: true })
    const result = await assistant.turn(QUESTION, { sessionId: 'h1' })
    expect(result.status).toBe('ok')
    expect(seen.propose).toBe(1)
    const msg = contextMessage(seen.loopMessages[0])
    expect(msg?.content).toContain('Soft-deleted rows are exported but hidden on the dashboard')
    expect(msg?.content).toContain('The dashboard refreshed before late rows arrived')
    expect(msg?.content).toContain('to tell it apart: count deleted rows')
    expect(result.trace?.layerActivity.some((l) => l.layer === 'hypothesis' && l.reason.startsWith('Weighing 2 competing explanations'))).toBe(true)
  })

  it('flag on but the classifier says the request is not underdetermined: no call, no note', async () => {
    process.env.AUDIT_SEMANTIC_HYPOTHESES = '1'
    const { assistant, seen } = build({ underdetermined: false })
    await assistant.turn(QUESTION, { sessionId: 'h2' })
    expect(seen.propose).toBe(0)
    expect(contextMessage(seen.loopMessages[0])).toBeUndefined()
  })

  it('flag off (the default) with an underdetermined request: no call, no note, nothing changes', async () => {
    const { assistant, seen } = build({ underdetermined: true })
    const result = await assistant.turn(QUESTION, { sessionId: 'h3' })
    expect(result.status).toBe('ok')
    expect(seen.propose).toBe(0)
    expect(seen.judge).toBe(0)
    expect(contextMessage(seen.loopMessages[0])).toBeUndefined()
  })

  describe('a tool-less turn (the reply is drafted before the harness runs)', () => {
    it('asks up front, shows the draft the explanations, and does not ask a second time when the harness registers them', async () => {
      process.env.AUDIT_SEMANTIC_HYPOTHESES = '1'
      const { assistant, seen } = build({ underdetermined: true, tools: false })
      const result = await assistant.turn(QUESTION, { sessionId: 'h4' })
      expect(result.status).toBe('ok')
      expect(seen.propose).toBe(1)
      expect(seen.draftSystems.at(-1)).toContain('can be explained several ways')
      expect(seen.draftSystems.at(-1)).toContain('The dashboard refreshed before late rows arrived')
      expect(result.trace?.layerActivity.some((l) => l.layer === 'hypothesis' && l.reason.startsWith('Weighing 2 competing explanations'))).toBe(true)
    })

    it('flag off, or not underdetermined: the draft prompt is untouched and nothing is asked', async () => {
      const off = build({ underdetermined: true, tools: false })
      await off.assistant.turn(QUESTION, { sessionId: 'h5' })
      expect(off.seen.propose).toBe(0)
      expect(off.seen.draftSystems.every((sys) => !sys.includes('can be explained several ways'))).toBe(true)

      process.env.AUDIT_SEMANTIC_HYPOTHESES = '1'
      const notUnder = build({ underdetermined: false, tools: false })
      await notUnder.assistant.turn(QUESTION, { sessionId: 'h6' })
      expect(notUnder.seen.propose).toBe(0)
    })
  })
})
