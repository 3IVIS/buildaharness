import { describe, it, expect, afterEach } from 'vitest'
import type { ChatMessage, ChatOptions, FsBackend, ILLMClient, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'
import { PersonalAssistant } from './assistant.js'
import { createScriptedLLMClient } from './scripted-llm-client.js'
import { InMemoryExperienceStore } from '@buildaharness/harness'

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

function build(matcherAnswer: string, persistent = false, layerPolicyMode?: 'static' | 'shadow' | 'adaptive', experienceStore?: InMemoryExperienceStore) {
  const inner = createScriptedLLMClient({ responses: ['The answer is 42.'], sideResponses: [[MATCHER_MARKER, matcherAnswer]] })
  const seen = { loopCalls: 0, matcherCalls: 0, loopMessages: [] as ChatMessage[][] }
  const client = {
    callChat: (m: ChatMessage[], o?: ChatOptions) => inner.callChat(m, o),
    callChatSync: (m: ChatMessage[], o?: ChatOptions) => inner.callChatSync(m, o),
    async callChatStructured(m: ChatMessage[], t?: ToolDefinition[], o?: ChatOptions): Promise<LLMStructuredResponse> {
      if ((m.find((x) => x.role === 'system')?.content ?? '').includes(MATCHER_MARKER)) {
        seen.matcherCalls++
        o?.onUsage?.({ inputTokens: 11, outputTokens: 7 }) // a real client reports usage on every call; the scripted one does not
      }
      if (t && t.length > 0) {
        seen.loopCalls++
        seen.loopMessages.push(m.map((x) => ({ ...x })))
        if (persistent || seen.loopCalls === 1) throw new Error('claude exited with code 1: API Error: 503 service unavailable')
      }
      return inner.callChatStructured(m, t, o)
    },
  } as ILLMClient
  return { assistant: new PersonalAssistant({ llmClient: client, fileTools: { backend, workspaceRoot: '/ws' }, ...(layerPolicyMode ? { layerPolicyMode } : {}), ...(experienceStore ? { experienceStore } : {}) }), seen }
}

const QUESTION = 'What is the answer? See notes.md'

describe('a transient model error mid-turn', () => {
  afterEach(() => { delete process.env.AUDIT_SEMANTIC_FAILURE_MATCH; delete process.env.AUDIT_RETRY_SYSTEM_ERRORS })

  it('is classified on its first failure and the task is retried to a real answer', async () => {
    const { assistant, seen } = build(MATCHED)
    const result = await assistant.turn(QUESTION, { sessionId: 't1' })
    expect(result.reply).toBe('The answer is 42.')
    expect(seen.loopCalls).toBe(2)
    expect(seen.matcherCalls).toBeGreaterThan(0)
    expect(result.trace?.layerActivity.some((l) => l.layer === 'recovery' && l.reason.includes('REIMPLEMENT'))).toBe(true)
  })

  it('negative control — the matcher finds no known failure pattern and the system-error retry is off: the turn gives up after the one failure', async () => {
    process.env.AUDIT_RETRY_SYSTEM_ERRORS = '0'
    const { assistant, seen } = build('{"matched":false}')
    const result = await assistant.turn(QUESTION, { sessionId: 't2' })
    expect(result.reply).toMatch(GAVE_UP)
    expect(seen.loopCalls).toBe(1)
  })

  it('negative control — AUDIT_SEMANTIC_FAILURE_MATCH=0 and the system-error retry off: no matcher call, the turn gives up', async () => {
    process.env.AUDIT_SEMANTIC_FAILURE_MATCH = '0'
    process.env.AUDIT_RETRY_SYSTEM_ERRORS = '0'
    const { assistant, seen } = build(MATCHED)
    const result = await assistant.turn(QUESTION, { sessionId: 't3' })
    expect(result.reply).toMatch(GAVE_UP)
    expect(seen.matcherCalls).toBe(0)
    expect(seen.loopCalls).toBe(1)
  })

  it('system-error retry (default): with no matcher finding, the one transient error is retried and the turn recovers', async () => {
    const { assistant, seen } = build('{"matched":false}')
    const result = await assistant.turn(QUESTION, { sessionId: 't4' })
    expect(result.reply).not.toMatch(GAVE_UP)
    expect(seen.loopCalls).toBe(2)
  })

  it('system-error retry (default): with the matcher also off, the transient error is still retried', async () => {
    process.env.AUDIT_SEMANTIC_FAILURE_MATCH = '0'
    const { assistant, seen } = build(MATCHED)
    const result = await assistant.turn(QUESTION, { sessionId: 't5' })
    expect(result.reply).not.toMatch(GAVE_UP)
    expect(seen.matcherCalls).toBe(0)
    expect(seen.loopCalls).toBe(2)
  })

  it('a PERSISTENT error is retried once, then ends in the honest could-not-complete reply (not an escalation)', async () => {
    const { assistant, seen } = build('{"matched":false}', true)
    const result = await assistant.turn(QUESTION, { sessionId: 'p1' })
    expect(result.status).toBe('ok')
    expect(result.reply).toMatch(GAVE_UP)
    expect(seen.loopCalls).toBe(2)
  })

  it('adaptive layer policy: a turn that starts routine still gets the failure matcher once a task fails', async () => {
    const { assistant, seen } = build(MATCHED, false, 'adaptive')
    const result = await assistant.turn(QUESTION, { sessionId: 'a1' })
    expect(result.reply).toBe('The answer is 42.')
    expect(seen.matcherCalls).toBeGreaterThan(0)
    expect(result.trace?.layerActivity.some((l) => l.layer === 'recovery' && l.reason.includes('REIMPLEMENT'))).toBe(true)
  })

  it('shadow telemetry: the matcher\'s real calls are measured, and the shadow decision for failure_match is the failure-aware one', async () => {
    const rows: Array<{ key: string; row: Record<string, unknown> }> = []
    class Recording extends InMemoryExperienceStore {
      override updateExperienceStore(key: string, data: Record<string, unknown>): void {
        if (/^(layer_outcome|shadow_turn):/.test(key)) rows.push({ key, row: data })
        super.updateExperienceStore(key, data)
      }
    }
    const { assistant, seen } = build(MATCHED, false, 'shadow', new Recording())
    const result = await assistant.turn(QUESTION, { sessionId: 'sh1' })
    expect(result.reply).toBe('The answer is 42.')
    expect(seen.matcherCalls).toBeGreaterThan(0)
    const shadow = rows.find((r) => r.row.kind === 'shadow_turn')!.row as { observedCalls: number; observedByLayer?: Record<string, number>; disagreements: Array<{ layer: string }> }
    expect(shadow.observedByLayer?.failure_match).toBe(seen.matcherCalls)
    expect(shadow.observedCalls).toBeGreaterThanOrEqual(seen.matcherCalls)
    // adaptive would run the matcher once a task has failed, so the shadow does not record a skip for it
    expect(shadow.disagreements.some((d) => d.layer === 'failure_match')).toBe(false)
    const outcome = rows.find((r) => r.row.kind === 'layer_outcome')!.row as { layers: Array<{ layer: string; calls: number; tokens: number }> }
    const fm = outcome.layers.find((l) => l.layer === 'failure_match')
    expect(fm?.calls).toBe(seen.matcherCalls)
    expect(fm?.tokens).toBeGreaterThanOrEqual(0)
  })
})
