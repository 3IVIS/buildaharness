import { describe, it, expect } from 'vitest'
import type { ChatMessage, ILLMClient, LLMStructuredResponse } from '@buildaharness/runtime'
import { checkTaskCompletion, semanticTaskCompletionEnabled, shortenForCheck } from './task-completion-check.js'

function client(respond: (messages: ChatMessage[]) => string | Error) {
  const seen: ChatMessage[][] = []
  const llm: ILLMClient = {
    async *callChat() { yield '' },
    async callChatSync() { return '' },
    async callChatStructured(messages: ChatMessage[]): Promise<LLMStructuredResponse> {
      seen.push(messages)
      const r = respond(messages)
      if (r instanceof Error) throw r
      return { content: r }
    },
  }
  return { llm, seen }
}

const input = { taskDescription: 'Define launch scope and metrics', output: "I can't run a project plan." }

describe('semanticTaskCompletionEnabled', () => {
  it('is OFF by default and for falsy values', () => {
    expect(semanticTaskCompletionEnabled({})).toBe(false)
    expect(semanticTaskCompletionEnabled({ AUDIT_SEMANTIC_TASK_COMPLETION: '' })).toBe(false)
    expect(semanticTaskCompletionEnabled({ AUDIT_SEMANTIC_TASK_COMPLETION: '0' })).toBe(false)
  })
  it('turns on for truthy values', () => {
    for (const v of ['1', 'true', 'ON', 'enabled']) expect(semanticTaskCompletionEnabled({ AUDIT_SEMANTIC_TASK_COMPLETION: v })).toBe(true)
  })
})

describe('checkTaskCompletion', () => {
  it('returns not done with the reason, and sends the task and output to the model', async () => {
    const { llm, seen } = client(() => '{"done":false,"reason":"the reply refuses the task"}')
    expect(await checkTaskCompletion(input, llm)).toEqual({ done: false, reason: 'the reply refuses the task' })
    expect(JSON.parse(seen[0].at(-1)!.content)).toEqual({ task: input.taskDescription, output: input.output })
  })

  it('returns done when the model says so', async () => {
    const { llm } = client(() => '{"done":true}')
    expect(await checkTaskCompletion(input, llm)).toEqual({ done: true })
  })

  it('takes the JSON object when the model puts prose before it', async () => {
    const { llm } = client(() => 'Let me think.\n{"done":false,"reason":"asks a question instead"}')
    expect(await checkTaskCompletion(input, llm)).toEqual({ done: false, reason: 'asks a question instead' })
  })

  it('fails open: an error, garbage or a non-boolean is done', async () => {
    expect(await checkTaskCompletion(input, client(() => new Error('down')).llm)).toEqual({ done: true })
    expect(await checkTaskCompletion(input, client(() => 'not json').llm)).toEqual({ done: true })
    expect(await checkTaskCompletion(input, client(() => '{"done":"no"}').llm)).toEqual({ done: true })
  })

  it('does not spend a call on an empty output', async () => {
    const { llm, seen } = client(() => '{"done":false}')
    expect(await checkTaskCompletion({ taskDescription: 'x', output: '   ' }, llm)).toEqual({ done: true })
    expect(seen).toHaveLength(0)
  })
})

describe('shortenForCheck', () => {
  it('leaves an output of ordinary step length whole', () => {
    const text = 'x'.repeat(11_000)
    expect(shortenForCheck(text)).toBe(text)
  })

  it('keeps the start and the end of a very long output and drops the middle, marked', () => {
    const text = 'HEAD' + 'a'.repeat(20_000) + 'TAIL'
    const shortened = shortenForCheck(text)
    expect(shortened.startsWith('HEAD')).toBe(true)
    expect(shortened.endsWith('TAIL')).toBe(true)
    expect(shortened).toContain('[... omitted ...]')
    expect(shortened.length).toBeLessThan(12_100)
  })

  it('the model sees a long deliverable\'s ending, so a rollback plan at the end is not lost', async () => {
    const { llm, seen } = client(() => '{"done":true}')
    await checkTaskCompletion({ taskDescription: 'Assess risks and write a rollback plan', output: 'r'.repeat(6000) + ' ROLLBACK PLAN: revert the flag.' }, llm)
    expect(JSON.parse(seen[0].at(-1)!.content).output).toContain('ROLLBACK PLAN: revert the flag.')
  })
})
