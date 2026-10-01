import { describe, it, expect, afterEach } from 'vitest'
import type { ChatMessage, ChatOptions, FsBackend, ILLMClient, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'
import { PersonalAssistant } from './assistant.js'
import { createScriptedLLMClient } from './scripted-llm-client.js'

// A transient model/subprocess error mid-turn (e.g. `claude exited with code 1: API Error: 503 service unavailable`) reaches the
// harness as a failed task on every backend. The semantic failure matcher must classify it on its FIRST failure so the curated
// strategy is chosen and the task retried, instead of the turn giving up with a could-not-complete reply.

const MATCHER_MARKER = 'You match a set of observed symptoms'
const MATCHED = '{"matched":true,"failure_class":"TOOL_UNAVAILABLE_CASCADE","matched_pattern":"tool-unavailable-cascade","confidence":0.9}'
const GAVE_UP = /couldn't complete this/

const backend: FsBackend = {
  async readTextFile(path) { return path.endsWith('notes.md') ? 'notes' : undefined },
  async writeTextFile() {},
  async removeFile() {},
  async mkdir() {},
  async readDir() { return [] },
}

function build(matcherAnswer: string) {
  const inner = createScriptedLLMClient({ responses: ['The answer is 42.'], sideResponses: [[MATCHER_MARKER, matcherAnswer]] })
  const seen = { loopCalls: 0, matcherCalls: 0, loopMessages: [] as ChatMessage[][] }
  const client = {
    callChat: (m: ChatMessage[], o?: ChatOptions) => inner.callChat(m, o),
    callChatSync: (m: ChatMessage[], o?: ChatOptions) => inner.callChatSync(m, o),
    async callChatStructured(m: ChatMessage[], t?: ToolDefinition[], o?: ChatOptions): Promise<LLMStructuredResponse> {
      if ((m.find((x) => x.role === 'system')?.content ?? '').includes(MATCHER_MARKER)) seen.matcherCalls++
      if (t && t.length > 0) {
        seen.loopCalls++
        seen.loopMessages.push(m.map((x) => ({ ...x })))
        if (seen.loopCalls === 1) throw new Error('claude exited with code 1: API Error: 503 service unavailable')
      }
      return inner.callChatStructured(m, t, o)
    },
  } as ILLMClient
  return { assistant: new PersonalAssistant({ llmClient: client, fileTools: { backend, workspaceRoot: '/ws' } }), seen }
}

const QUESTION = 'What is the answer? See notes.md'

describe('a transient model error mid-turn', () => {
  afterEach(() => { delete process.env.AUDIT_SEMANTIC_FAILURE_MATCH })

  it('is classified on its first failure and the task is retried to a real answer', async () => {
    const { assistant, seen } = build(MATCHED)
    const result = await assistant.turn(QUESTION, { sessionId: 't1' })
    expect(result.reply).toBe('The answer is 42.')
    expect(seen.loopCalls).toBe(2)
    expect(seen.matcherCalls).toBeGreaterThan(0)
    expect(result.trace?.layerActivity.some((l) => l.layer === 'recovery' && l.reason.includes('REIMPLEMENT'))).toBe(true)
  })

  it('negative control — the matcher finds no known failure pattern: the turn gives up after the one failure', async () => {
    const { assistant, seen } = build('{"matched":false}')
    const result = await assistant.turn(QUESTION, { sessionId: 't2' })
    expect(result.reply).toMatch(GAVE_UP)
    expect(seen.loopCalls).toBe(1)
  })

  it('negative control — AUDIT_SEMANTIC_FAILURE_MATCH=0: no matcher call, the turn gives up', async () => {
    process.env.AUDIT_SEMANTIC_FAILURE_MATCH = '0'
    const { assistant, seen } = build(MATCHED)
    const result = await assistant.turn(QUESTION, { sessionId: 't3' })
    expect(result.reply).toMatch(GAVE_UP)
    expect(seen.matcherCalls).toBe(0)
    expect(seen.loopCalls).toBe(1)
  })
})
