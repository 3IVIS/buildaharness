import type { ILLMClient } from '@buildaharness/runtime'
import type { DecomposedTaskSpec } from './decomposition-classifier.js'
import type { PlanTemplate } from './plan-templates/index.js'

export interface Plan {
  templateName: string
  successCriteria: string
  tasks: DecomposedTaskSpec[]
}

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          description: { type: 'string' },
          depends_on: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'description', 'depends_on'],
      },
    },
  },
  required: ['tasks'],
}

function buildSystemPrompt(template: PlanTemplate): string {
  const skeleton = template.tasks
    .map((t) => `- id: ${t.id}; title: ${t.title}; depends_on: [${t.depends_on.join(', ')}]`)
    .join('\n')
  return (
    `You are adapting a "${template.name}" plan template to a specific user request. ` +
    `Here is the template's task skeleton — keep the exact same ids and depends_on structure, ` +
    `one output task per skeleton task, but personalize each description to the actual request:\n${skeleton}\n\n` +
    `Success criteria for this kind of plan: ${template.success_criteria}\n\n` +
    'Respond with JSON only, no prose: {"tasks":[{"id": string, "description": string, "depends_on": ' +
    'string[]}]}. `id` and `depends_on` values must exactly match the skeleton above.'
  )
}

function isDecomposedTaskSpec(value: unknown): value is DecomposedTaskSpec {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === 'string' &&
    typeof v.description === 'string' &&
    Array.isArray(v.depends_on) &&
    v.depends_on.every((d) => typeof d === 'string')
  )
}

/**
 * Spends one real LLM call personalizing `template`'s task skeleton to `message` —
 * only called once classifyPlanningCandidate has already flagged the request, so an
 * ordinary turn never pays for this. Same "malformed/incomplete JSON is the expected
 * failure mode, not the edge case" fallback as decomposeObjective: any parse failure
 * or a response with fewer than 2 usable tasks returns null, meaning "fall back to
 * the caller's own ad hoc decomposition for this turn" rather than throwing.
 */
export async function buildPlanFromTemplate(
  llmClient: ILLMClient,
  message: string,
  template: PlanTemplate,
  model?: string,
): Promise<Plan | null> {
  try {
    const response = await llmClient.callChatStructured(
      [
        { role: 'system', content: buildSystemPrompt(template) },
        { role: 'user', content: message },
      ],
      undefined,
      { model, structuredOutput: { schema: PLAN_SCHEMA } },
    )
    const parsed = JSON.parse(response.content) as { tasks?: unknown }
    if (!Array.isArray(parsed.tasks)) return null
    const tasks = parsed.tasks.filter(isDecomposedTaskSpec)
    if (tasks.length <= 1) return null
    return { templateName: template.name, successCriteria: template.success_criteria, tasks }
  } catch {
    return null
  }
}
