import type { ILLMClient, TokenUsage } from '@buildaharness/runtime'
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
    'Phrase each `description` starting with the concrete subject or object it acts on (e.g. "the login tests: ' +
    'rerun after the config fix" rather than "rerun the login tests after the config fix"), so later comparisons ' +
    "against this task's completion/failure beliefs share matching vocabulary. " +
    'Respond with JSON only, no prose: {"tasks":[{"id": string, "description": string, "depends_on": ' +
    'string[]}]}. `id` and `depends_on` values must exactly match the skeleton above.'
  )
}

// Only the shape the LLM actually returns (id/description/depends_on) — riskLevel isn't asked for
// here at all (see buildPlanFromTemplate's doc comment for why) and gets attached afterward from
// the template's own already-curated risk_level, so this is deliberately narrower than
// DecomposedTaskSpec itself.
interface RawPlanTask {
  id: string
  description: string
  depends_on: string[]
}

function isRawPlanTask(value: unknown): value is RawPlanTask {
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
 * only called once classifyTurnIntent has already named a matchedPlanTemplate, so an
 * ordinary turn never pays for this. Same "malformed/incomplete JSON is the expected
 * failure mode, not the edge case" fallback classifyTurnIntent itself uses: any parse
 * failure or a response with fewer than 2 usable tasks returns null, meaning "fall back to
 * the caller's own ad hoc decomposition for this turn" rather than throwing.
 *
 * Each output task's `riskLevel` is attached from the matching skeleton task's own
 * `risk_level` (curated by whoever wrote the template's JSON) by id, not asked of the LLM —
 * the template already has this, more accurately than an LLM re-deriving it from a
 * personalized one-line description would, and it costs zero extra output tokens. Falls back
 * to 'LOW' only for the pathological case of a task id the LLM invented that doesn't match any
 * skeleton task (the id/depends_on-must-match-skeleton instruction above means this should not
 * happen in practice).
 */
export async function buildPlanFromTemplate(
  llmClient: ILLMClient,
  message: string,
  template: PlanTemplate,
  model?: string,
  onUsage?: (usage: TokenUsage) => void,
): Promise<Plan | null> {
  try {
    const response = await llmClient.callChatStructured(
      [
        { role: 'system', content: buildSystemPrompt(template) },
        { role: 'user', content: message },
      ],
      undefined,
      { model, onUsage, structuredOutput: { schema: PLAN_SCHEMA } },
    )
    const parsed = JSON.parse(response.content) as { tasks?: unknown }
    if (!Array.isArray(parsed.tasks)) return null
    const rawTasks = parsed.tasks.filter(isRawPlanTask)
    if (rawTasks.length <= 1) return null
    const riskByTemplateId = new Map(template.tasks.map((t) => [t.id, t.risk_level]))
    const tasks: DecomposedTaskSpec[] = rawTasks.map((t) => ({ ...t, riskLevel: riskByTemplateId.get(t.id) ?? 'LOW' }))
    return { templateName: template.name, successCriteria: template.success_criteria, tasks }
  } catch {
    return null
  }
}
