import { describe, it, expect } from 'vitest'
import type { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'
import { buildPlanFromTemplate } from './plan-builder.js'
import { loadTemplate } from './plan-templates/index.js'

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

describe('buildPlanFromTemplate', () => {
  const template = loadTemplate('project_planning')

  it('returns a Plan whose task ids/depends_on match the template structure, with personalized descriptions', async () => {
    const personalized = template.tasks.map((t) => ({ id: t.id, description: `${t.title} — for the Q3 launch`, depends_on: t.depends_on }))
    const llm = new StructuredOnlyLLMClient(JSON.stringify({ tasks: personalized }))

    const plan = await buildPlanFromTemplate(llm, 'Plan and launch the Q3 onboarding redesign.', template)

    expect(plan).not.toBeNull()
    expect(plan!.templateName).toBe('project_planning')
    expect(plan!.successCriteria).toBe(template.success_criteria)
    expect(plan!.tasks.map((t) => t.id)).toEqual(template.tasks.map((t) => t.id))
    expect(plan!.tasks[0].description).toContain('Q3 launch')
    expect(llm.calls).toBe(1)
  })

  it('seeds the system prompt with the template skeleton and success criteria', async () => {
    const llm = new StructuredOnlyLLMClient(JSON.stringify({ tasks: [
      { id: 'a', description: 'x', depends_on: [] },
      { id: 'b', description: 'y', depends_on: ['a'] },
    ] }))

    await buildPlanFromTemplate(llm, 'Plan and launch something.', template)

    const systemMessage = llm.receivedMessages[0][0]
    expect(systemMessage.role).toBe('system')
    expect(systemMessage.content).toContain(template.name)
    expect(systemMessage.content).toContain(template.success_criteria)
    expect(systemMessage.content).toContain(template.tasks[0].id)
  })

  it('returns null for malformed JSON instead of throwing', async () => {
    const llm = new StructuredOnlyLLMClient('not valid json')

    expect(await buildPlanFromTemplate(llm, 'Plan a launch.', template)).toBeNull()
  })

  it('returns null when fewer than 2 valid tasks remain (mirrors classifyTurnIntent\'s own decomposedTasks fallback)', async () => {
    const llm = new StructuredOnlyLLMClient(JSON.stringify({ tasks: [{ id: 'only', description: 'one task', depends_on: [] }] }))

    expect(await buildPlanFromTemplate(llm, 'Plan a launch.', template)).toBeNull()
  })

  it('returns null when the response is well-formed JSON but missing the tasks field', async () => {
    const llm = new StructuredOnlyLLMClient(JSON.stringify({ notTasks: [] }))

    expect(await buildPlanFromTemplate(llm, 'Plan a launch.', template)).toBeNull()
  })
})
