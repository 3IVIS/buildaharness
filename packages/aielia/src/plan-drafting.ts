import type { ILLMClient, TokenUsage } from '@buildaharness/runtime'
import { validateAskQuestion, type AskQuestion } from '@buildaharness/harness'
import type { DecomposedTaskSpec } from './decomposition-classifier.js'
import type { PlanTaskRecord } from './plan-store.js'

/**
 * P1 of the internal plan — the "plan-drafting revision call" P1's
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
  /**
   * P2 of the internal plan — true only once the model judges the user
   * has clearly signaled they're satisfied with the current draft and want to proceed, at which
   * point PlanDraftingService hands off to PlanApprovalService instead of returning another plain
   * drafting reply. Defaults false on any malformed/missing value (see parsing below) — a
   * misparsed response must never accidentally fast-track a plan into the approval gate.
   */
  readyForApproval: boolean
  /**
   * P8 of the internal plan — set only when this revision hit a genuine
   * ambiguity worth pausing on instead of guessing (an ambiguous scope boundary, or a
   * MEDIUM/HIGH-risk branch point with more than one viable approach) — e.g. "which of these two
   * frameworks should the plan target?" A drafting call that sets this always also leaves
   * `readyForApproval` false; `PlanDraftingService.draftTurn` stages it as a nested
   * `needs_clarification` exchange (reusing Q0's `AskQuestion` shape and Q2/Q5/Q6's existing
   * rendering) instead of treating `reply`/`tasks` as an ordinary revision, and the user's answer
   * folds into the *next* drafting call as its `userMessage` rather than resuming a harness run
   * (there is no harness run mid-draft to resume — see plan-drafting-service.ts's doc comment).
   * Absent on every ordinary revision, same "absent when unused" convention the rest of this
   * module follows.
   */
  question?: AskQuestion
}

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    success_criteria: { type: 'string' },
    rationale: { type: 'string' },
    ready_for_approval: { type: 'boolean' },
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
    question: {
      type: ['object', 'null'],
      properties: {
        id: { type: 'string' },
        question: { type: 'string' },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: { label: { type: 'string' } },
            required: ['label'],
          },
        },
      },
      required: ['id', 'question', 'options'],
    },
  },
  required: ['reply', 'success_criteria', 'rationale', 'tasks'],
}

function buildSystemPrompt(): string {
  return (
    'You are drafting a multi-step plan with the user, one revision at a time — you have NO tools ' +
    'available in this mode, only this conversation. Each user message either refines the plan ' +
    "(add/remove/reorder/reword tasks) or asks a question about the current draft. Respond with JSON " +
    'only, no prose: {"reply": string, "success_criteria": string, "rationale": string, ' +
    '"ready_for_approval": boolean, "tasks": ' +
    '[{"id": string, "description": string, "depends_on": string[], "risk_level": "LOW"|"MEDIUM"|"HIGH"}], ' +
    '"question": {"id": string, "question": string, "options": [{"label": string}, ...]} | null}. ' +
    '`reply` is a short, conversational summary of the current draft (or an answer to the user\'s ' +
    'question) to show them directly — do not repeat the raw task list in it. `rationale` explains why ' +
    'this approach, not just what the tasks are. This plan is not executed until the user explicitly ' +
    'approves it later, so it is safe to draft steps that would otherwise be risky. Set ' +
    '`ready_for_approval` to true ONLY when the user has clearly signaled they are satisfied with ' +
    'the draft and want to proceed with it (e.g. "looks good", "let\'s do this", "approve it") — ' +
    'leave it false while still refining, or when the message just asks a question about the draft. ' +
    'Only set `question` (and leave it null otherwise) when you hit a genuine ambiguity worth pausing ' +
    'on instead of guessing — an unclear scope boundary, or a MEDIUM/HIGH-risk branch point with more ' +
    'than one viable approach — never for something you could reasonably decide yourself. `question.options` ' +
    'must have between 2 and 4 entries. When you set `question`, also set `ready_for_approval` to false ' +
    'and echo the current `tasks`/`success_criteria`/`rationale` back unchanged (you are pausing on this ' +
    'revision, not making one).'
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
  /**
   * P3 of the internal plan — grounding text for a from-scratch (no
   * template match) draft, gathered from a bounded read_file/list_directory investigation walk
   * (see AgentLoop.runSupervisorInvestigation, reused rather than building a new search engine —
   * Scope & non-goals) so a code-shaped request's draft can reference real repo state instead of
   * guessing. Absent for every other call (a template-seeded draft, or any revision after the
   * first) — same "absent when unused" convention the rest of this module follows.
   */
  groundingContext?: string,
): Promise<PlanDraftTurn | null> {
  try {
    const groundingMessages: { role: 'user'; content: string }[] = groundingContext
      ? [{ role: 'user', content: `Grounding — real repo state found while preparing this draft:\n${groundingContext}` }]
      : []
    const response = await llmClient.callChatStructured(
      [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: describeDraft(currentTasks, currentSuccessCriteria, currentRationale) },
        ...groundingMessages,
        { role: 'user', content: userMessage },
      ],
      undefined,
      { model, onUsage, structuredOutput: { schema: DRAFT_SCHEMA } },
    )
    const parsed = JSON.parse(response.content) as {
      reply?: unknown
      success_criteria?: unknown
      rationale?: unknown
      ready_for_approval?: unknown
      tasks?: unknown
      question?: unknown
    }
    if (typeof parsed.reply !== 'string' || typeof parsed.success_criteria !== 'string' || typeof parsed.rationale !== 'string') return null
    if (!Array.isArray(parsed.tasks)) return null
    const rawTasks = parsed.tasks.filter(isValidTask)
    if (rawTasks.length === 0) return null
    const tasks: DecomposedTaskSpec[] = rawTasks.map((t) => ({ id: t.id, description: t.description, depends_on: t.depends_on, riskLevel: t.risk_level }))
    const readyForApproval = typeof parsed.ready_for_approval === 'boolean' ? parsed.ready_for_approval : false
    // P8: a malformed/out-of-cap `question` (INV-34's 2-4 option range) is dropped rather than
    // failing the whole revision — a genuine parse/validation failure here just means this
    // revision proceeds as an ordinary (non-nested-ask) one, same fail-safe spirit as
    // draftReply's own "malformed JSON is the expected failure mode" contract, just scoped to
    // one optional field instead of the whole response.
    const question = parseQuestion(parsed.question)
    return { reply: parsed.reply, tasks, successCriteria: parsed.success_criteria, rationale: parsed.rationale, readyForApproval: question ? false : readyForApproval, question }
  } catch {
    return null
  }
}

function isValidQuestionShape(value: unknown): value is { id: string; question: string; options: { label: string }[] } {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === 'string' &&
    typeof v.question === 'string' &&
    Array.isArray(v.options) &&
    v.options.every((o) => typeof o === 'object' && o !== null && typeof (o as Record<string, unknown>).label === 'string')
  )
}

/** P8 — validates a model-proposed `question` against Q0's own construction-time caps (INV-34), reusing the shared validator rather than re-deriving the 2-4 option bound here. Returns undefined (never throws) on anything malformed or out of range, so one bad field degrades this revision to an ordinary one instead of failing it outright. */
function parseQuestion(value: unknown): AskQuestion | undefined {
  if (value === null || value === undefined) return undefined
  if (!isValidQuestionShape(value)) return undefined
  const question: AskQuestion = { id: value.id, question: value.question, options: value.options.map((o) => ({ label: o.label })) }
  try {
    validateAskQuestion(question)
  } catch {
    return undefined
  }
  return question
}
