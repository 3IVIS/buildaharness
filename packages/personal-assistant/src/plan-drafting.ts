import type { ILLMClient, TokenUsage } from '@buildaharness/runtime'
import type { DecomposedTaskSpec } from './decomposition-classifier.js'
import type { PlanTaskRecord } from './plan-store.js'

/**
 * P1 of plans/ask_question_and_plan_mode_plan.html — the "plan-drafting revision call" P1's
 * routing (assistant.ts's runTurn, PlanDraftingService) sends every message to while
 * `planMode.active`. Deliberately narrower than P3's eventual version: no tools at all (P3 adds
 * read_file/list_directory grounding for a from-scratch draft — see Section &amp; non-goals),
 * only revises the running draft from conversation text. Kept in its own module, same reasoning
 * plan-builder.ts documents for buildPlanFromTemplate: a single-purpose LLM call, unit-testable
 * without the rest of the drafting plumbing.
 */
export interface PlanDraftTurn {
  /** A short, human-readable summary of the current draft, shown back to the user as the turn's reply. */
  reply: string
  tasks: DecomposedTaskSpec[]
  successCriteria: string
  rationale: string
}

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    success_criteria: { type: 'string' },
    rationale: { type: 'string' },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          description: { type: 'string' },
          depends_on: { type: 'array', items: { type: 'string' } },
          risk_level: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
        },
        required: ['id', 'description', 'depends_on', 'risk_level'],
      },
    },
  },
  required: ['reply', 'success_criteria', 'rationale', 'tasks'],
}

function buildSystemPrompt(): string {
  return (
    'You are drafting a multi-step plan with the user, one revision at a time — you have NO tools ' +
    'available in this mode, only this conversation. Each user message either refines the plan ' +
    "(add/remove/reorder/reword tasks) or asks a question about the current draft. Respond with JSON " +
    'only, no prose: {"reply": string, "success_criteria": string, "rationale": string, "tasks": ' +
    '[{"id": string, "description": string, "depends_on": string[], "risk_level": "LOW"|"MEDIUM"|"HIGH"}]}. ' +
    '`reply` is a short, conversational summary of the current draft (or an answer to the user\'s ' +
    'question) to show them directly — do not repeat the raw task list in it. `rationale` explains why ' +
    'this approach, not just what the tasks are. This plan is not executed until the user explicitly ' +
    'approves it later, so it is safe to draft steps that would otherwise be risky.'
  )
}

/** Renders the running draft as one message so the model sees exactly what it revised last turn, without re-deriving it from the raw transcript. */
function describeDraft(tasks: PlanTaskRecord[], successCriteria: string, rationale: string): string {
  if (tasks.length === 0) return '(No draft yet — this is the first message.)'
  const lines = tasks.map((t) => `- id: ${t.id}; ${t.description}; depends_on: [${t.depends_on.join(', ')}]; risk: ${t.riskLevel ?? 'LOW'}`)
  return `Current draft:\nSuccess criteria: ${successCriteria}\nRationale: ${rationale}\nTasks:\n${lines.join('\n')}`
}

function isValidTask(value: unknown): value is { id: string; description: string; depends_on: string[]; risk_level: 'LOW' | 'MEDIUM' | 'HIGH' } {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === 'string' &&
    typeof v.description === 'string' &&
    Array.isArray(v.depends_on) &&
    v.depends_on.every((d) => typeof d === 'string') &&
    (v.risk_level === 'LOW' || v.risk_level === 'MEDIUM' || v.risk_level === 'HIGH')
  )
}

/**
 * Spends one real LLM call revising the draft given `userMessage` — same "malformed/incomplete
 * JSON is the expected failure mode, not the edge case" fallback buildPlanFromTemplate uses: any
 * parse failure, or a response with zero usable tasks, returns null (caller keeps the draft
 * unchanged and reports a generic "couldn't update the draft" reply rather than staging garbage).
 */
export async function draftPlanRevision(
  llmClient: ILLMClient,
  userMessage: string,
  currentTasks: PlanTaskRecord[],
  currentSuccessCriteria: string,
  currentRationale: string,
  model?: string,
  onUsage?: (usage: TokenUsage) => void,
): Promise<PlanDraftTurn | null> {
  try {
    const response = await llmClient.callChatStructured(
      [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: describeDraft(currentTasks, currentSuccessCriteria, currentRationale) },
        { role: 'user', content: userMessage },
      ],
      undefined,
      { model, onUsage, structuredOutput: { schema: DRAFT_SCHEMA } },
    )
    const parsed = JSON.parse(response.content) as {
      reply?: unknown
      success_criteria?: unknown
      rationale?: unknown
      tasks?: unknown
    }
    if (typeof parsed.reply !== 'string' || typeof parsed.success_criteria !== 'string' || typeof parsed.rationale !== 'string') return null
    if (!Array.isArray(parsed.tasks)) return null
    const rawTasks = parsed.tasks.filter(isValidTask)
    if (rawTasks.length === 0) return null
    const tasks: DecomposedTaskSpec[] = rawTasks.map((t) => ({ id: t.id, description: t.description, depends_on: t.depends_on, riskLevel: t.risk_level }))
    return { reply: parsed.reply, tasks, successCriteria: parsed.success_criteria, rationale: parsed.rationale }
  } catch {
    return null
  }
}
