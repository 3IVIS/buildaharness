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

  describe('tolerant parse and retry', () => {
    const draft = {
      reply: 'Drafted two steps.',
      success_criteria: 'Ships on time.',
      rationale: 'Research first.',
      tasks: [
        { id: 't1', description: 'Research', depends_on: [], risk_level: 'LOW' },
        { id: 't2', description: 'Write', depends_on: ['t1'], risk_level: 'LOW' },
      ],
    }

    class SequencedLLMClient extends StructuredOnlyLLMClient {
      constructor(private readonly contents: string[]) {
        super('')
      }
      async callChatStructured(messages: ChatMessage[]): Promise<LLMStructuredResponse> {
        this.calls++
        this.receivedMessages.push(messages)
        return { content: this.contents[Math.min(this.calls - 1, this.contents.length - 1)] }
      }
    }

    it('reads a fenced draft behind a stray tag, and returns the whole draft rather than a nested task', async () => {
      const llm = new StructuredOnlyLLMClient('<invoke name="none">\n</invoke>\n```json\n' + JSON.stringify(draft) + '\n```')
      const revision = await draftPlanRevision(llm, 'Plan.', [], '', '')
      expect(revision!.tasks.map((t) => t.id)).toEqual(['t1', 't2'])
      expect(llm.calls).toBe(1)
    })

    it('retries once with a JSON-only reminder when the first response is prose, and uses the second', async () => {
      const llm = new SequencedLLMClient(['Here is the plan:\n- id: t1\n  description: Research', JSON.stringify(draft)])
      const revision = await draftPlanRevision(llm, 'Plan.', [], '', '')
      expect(revision!.tasks).toHaveLength(2)
      expect(llm.calls).toBe(2)
      expect(llm.receivedMessages[0].some((m) => m.content.includes('not the required JSON'))).toBe(false)
      expect(llm.receivedMessages[1].at(-1)!.content).toContain('not the required JSON')
    })

    it('gives up after one retry and returns null', async () => {
      const llm = new StructuredOnlyLLMClient('still prose')
      expect(await draftPlanRevision(llm, 'Plan.', [], '', '')).toBeNull()
      expect(llm.calls).toBe(2)
    })

    it('does not retry a call that throws', async () => {
      let calls = 0
      const llm = {
        ...new StructuredOnlyLLMClient(''),
        callChatStructured: async () => {
          calls++
          throw new Error('network')
        },
      } as unknown as ILLMClient
      expect(await draftPlanRevision(llm, 'Plan.', [], '', '')).toBeNull()
      expect(calls).toBe(1)
    })
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

  // P8 of the internal plan — nested ask-question support.
  describe('question (P8)', () => {
    const baseFields = {
      reply: 'Which approach should this plan use?',
      success_criteria: 'The launch ships on time.',
      rationale: 'Split research from execution so blockers surface early.',
      tasks: [{ id: 't1', description: 'Research competitors', depends_on: [], risk_level: 'LOW' }],
    }

    it('parses a well-formed question and forces readyForApproval false even if the model said true', async () => {
      const llm = new StructuredOnlyLLMClient(
        JSON.stringify({
          ...baseFields,
          ready_for_approval: true,
          question: { id: 'q1', question: 'Which framework?', options: [{ label: 'React' }, { label: 'Vue' }] },
        }),
      )
      const revision = await draftPlanRevision(llm, 'Plan a product launch.', [], '', '')
      expect(revision).not.toBeNull()
      expect(revision!.question).toEqual({ id: 'q1', question: 'Which framework?', options: [{ label: 'React' }, { label: 'Vue' }] })
      expect(revision!.readyForApproval).toBe(false)
    })

    it('leaves question undefined when the field is null', async () => {
      const llm = new StructuredOnlyLLMClient(JSON.stringify({ ...baseFields, question: null }))
      const revision = await draftPlanRevision(llm, 'Plan a product launch.', [], '', '')
      expect(revision!.question).toBeUndefined()
    })

    it('drops an out-of-cap question (too few options) rather than failing the whole revision', async () => {
      const llm = new StructuredOnlyLLMClient(
        JSON.stringify({ ...baseFields, question: { id: 'q1', question: 'Which framework?', options: [{ label: 'React' }] } }),
      )
      const revision = await draftPlanRevision(llm, 'Plan a product launch.', [], '', '')
      expect(revision).not.toBeNull()
      expect(revision!.question).toBeUndefined()
      expect(revision!.tasks.length).toBe(1)
    })

    it('drops an out-of-cap question (too many options)', async () => {
      const llm = new StructuredOnlyLLMClient(
        JSON.stringify({
          ...baseFields,
          question: { id: 'q1', question: 'Which framework?', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }, { label: 'D' }, { label: 'E' }] },
        }),
      )
      const revision = await draftPlanRevision(llm, 'Plan a product launch.', [], '', '')
      expect(revision!.question).toBeUndefined()
    })

    it('drops a malformed question shape (missing question text)', async () => {
      const llm = new StructuredOnlyLLMClient(
        JSON.stringify({ ...baseFields, question: { id: 'q1', options: [{ label: 'React' }, { label: 'Vue' }] } }),
      )
      const revision = await draftPlanRevision(llm, 'Plan a product launch.', [], '', '')
      expect(revision!.question).toBeUndefined()
    })
  })
})
