import { describe, it, expect } from 'vitest'
import type { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'
import { draftPlanRevision } from './plan-drafting.js'

class StructuredOnlyLLMClient implements ILLMClient {
  calls = 0
  receivedMessages: ChatMessage[][] = []
  constructor(private readonly content: string) {}

  async *callChat(): AsyncIterable<string> {
    yield ''
  }

  async callChatSync(): Promise<string> {
    return ''
  }

  async callChatStructured(messages: ChatMessage[], _tools?: ToolDefinition[], _options?: ChatOptions): Promise<LLMStructuredResponse> {
    this.calls++
    this.receivedMessages.push(messages)
    return { content: this.content }
  }
}

describe('draftPlanRevision', () => {
  it('returns a PlanDraftTurn from a well-formed response, with no tools offered to the model', async () => {
    const llm = new StructuredOnlyLLMClient(
      JSON.stringify({
        reply: 'Drafted two steps for the launch.',
        success_criteria: 'The launch ships on time.',
        rationale: 'Split research from execution so blockers surface early.',
        tasks: [
          { id: 't1', description: 'Research competitors', depends_on: [], risk_level: 'LOW' },
          { id: 't2', description: 'Write the launch doc', depends_on: ['t1'], risk_level: 'LOW' },
        ],
      }),
    )

    const revision = await draftPlanRevision(llm, 'Plan a product launch.', [], '', '')

    expect(revision).not.toBeNull()
    expect(revision!.reply).toBe('Drafted two steps for the launch.')
    expect(revision!.tasks.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(revision!.successCriteria).toBe('The launch ships on time.')
    expect(llm.calls).toBe(1)
  })

  it('returns null on malformed JSON', async () => {
    const llm = new StructuredOnlyLLMClient('not json')
    expect(await draftPlanRevision(llm, 'Plan something.', [], '', '')).toBeNull()
  })

  it('returns null when the response has zero usable tasks', async () => {
    const llm = new StructuredOnlyLLMClient(
      JSON.stringify({ reply: 'Hmm.', success_criteria: '', rationale: '', tasks: [] }),
    )
    expect(await draftPlanRevision(llm, 'Plan something.', [], '', '')).toBeNull()
  })

  it('returns null when a task is missing a required field', async () => {
    const llm = new StructuredOnlyLLMClient(
      JSON.stringify({ reply: 'Hmm.', success_criteria: '', rationale: '', tasks: [{ id: 't1', description: 'x' }] }),
    )
    expect(await draftPlanRevision(llm, 'Plan something.', [], '', '')).toBeNull()
  })
})
