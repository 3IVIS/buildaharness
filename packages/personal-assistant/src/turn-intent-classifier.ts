import type { ILLMClient, TokenUsage } from '@buildaharness/runtime'
import { listTemplateNames } from './plan-templates/index.js'
import type { DecomposedTaskSpec } from './decomposition-classifier.js'

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH'

export interface TurnIntentContext {
  /** Whether an active durable plan exists for this session — gates whether the abandon
   *  judgment means anything and whether plan-template matching should even be attempted
   *  (mirrors assistant.ts's own `if (activePlan) { ... } else { match a template } ` split). */
  hasActivePlan: boolean
}

export interface TurnIntentClassification {
  riskLevel: RiskLevel
  riskReason: string
  requiresApproval: boolean
  /** Only meaningful when riskLevel === 'LOW' — same precondition classifyTriviality had. */
  isTrivial: boolean
  decomposedTasks: DecomposedTaskSpec[] | null
  /** True when the request asks to create a calendar/reminder entry (regardless of how many). */
  isReminderRequest: boolean
  /** True when isReminderRequest is true AND the request looks like it may create more than one
   *  reminder in a single turn — same signal risk-classifier.ts's BULK_REMINDER_REASON gated on,
   *  folded into requiresApproval the same way. Always false when isReminderRequest is false. */
  isBulkReminderRequest: boolean
  /** Only meaningful when context.hasActivePlan is true. */
  isAbandonRequest: boolean
  /** One of listTemplateNames()'s names, or null. Only ever set when context.hasActivePlan is false. */
  matchedPlanTemplate: string | null
}

const FAIL_SAFE_REASON = 'Conversational request with no detected side effects.'

function failSafeClassification(): TurnIntentClassification {
  return {
    riskLevel: 'LOW',
    riskReason: FAIL_SAFE_REASON,
    requiresApproval: false,
    isTrivial: false,
    decomposedTasks: null,
    isReminderRequest: false,
    isBulkReminderRequest: false,
    isAbandonRequest: false,
    matchedPlanTemplate: null,
  }
}

const TASK_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    description: { type: 'string' },
    depends_on: { type: 'array', items: { type: 'string' } },
  },
  required: ['id', 'description', 'depends_on'],
}

const TURN_INTENT_SCHEMA = {
  type: 'object',
  properties: {
    riskLevel: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
    riskReason: { type: 'string' },
    isTrivial: { type: 'boolean' },
    decomposedTasks: { type: 'array', items: TASK_SCHEMA },
    isReminderRequest: { type: 'boolean' },
    isBulkReminderRequest: { type: 'boolean' },
    isAbandonRequest: { type: 'boolean' },
    matchedPlanTemplate: { type: ['string', 'null'], enum: [...listTemplateNames(), null] },
  },
  required: ['riskLevel', 'riskReason', 'isTrivial', 'decomposedTasks', 'isReminderRequest', 'isBulkReminderRequest', 'isAbandonRequest', 'matchedPlanTemplate'],
}

/**
 * Single consolidated judgment covering the five classifiers assistant.ts's runTurn() used to
 * run separately (risk, triviality, decomposition candidacy, plan-abandonment, plan-template
 * match) against the same raw user message — see
 * plans/personal_assistant_consolidated_classifier_plan.html for the full rationale. Each field's
 * contract matches what its former single-purpose classifier produced, so callers don't need to
 * change their downstream handling, only how the classification is obtained.
 *
 * Deliberately works in any language, not just English — the regex gates this replaces were
 * English-only by construction; this prompt is explicitly instructed not to assume English.
 */
const TURN_INTENT_SYSTEM_PROMPT =
  "Classify the user's message across six independent judgments, for a personal-assistant that " +
  'can send messages, delete files, spend money, publish content, manage subscriptions/bookings, ' +
  'create reminders, and run durable multi-step plans on the user\'s behalf. The message may be in ' +
  'any language — judge the actual meaning, never assume English.\n\n' +
  '1. riskLevel + riskReason: how consequential the request is if acted on literally. HIGH: sends ' +
  "a message on the user's behalf, deletes/removes something possibly irreversibly, spends money or " +
  'moves funds, publishes content publicly, cancels a subscription or commitment, or signs/submits ' +
  'a binding document. MEDIUM: books, schedules, reserves, or creates a calendar/reminder entry. ' +
  'LOW: everything else — conversational or informational, no real-world side effects. A question ' +
  'about whether/how an action already happened (past tense, or reported as a third party\'s action) ' +
  'is not a live request — classify by what is actually being asked for now.\n\n' +
  '2. isTrivial: true only if riskLevel is LOW AND the message is a single, short, self-contained ' +
  'factual question with no reference to prior conversation and no request for reasoning, comparison, ' +
  'or generated content. Always false when riskLevel is not LOW.\n\n' +
  '3. decomposedTasks: if the request is really just one step, return an empty array. If it names ' +
  'multiple distinct sub-tasks (sequencing words, an enumerated/numbered list, or a long compound ' +
  'request), return an ordered list of concrete sub-tasks, each `description` starting with the ' +
  'concrete subject or object it acts on (e.g. "the login tests: rerun after the config fix" rather ' +
  'than "rerun the login tests after the config fix"). `id` values must be unique; `depends_on` ' +
  'lists the ids of tasks that must complete first (usually just the previous task, or empty for ' +
  'the first one).\n\n' +
  '4. isReminderRequest: true if the request asks to create a reminder or calendar entry. ' +
  'isBulkReminderRequest: only meaningful when isReminderRequest is true — true if it names or ' +
  'implies more than one distinct reminder in this single turn.\n\n' +
  '5. isAbandonRequest: true only if the user is asking to abandon, cancel, or scrap an ENTIRE ' +
  'active multi-step plan (not a question about it, a tweak to one of its tasks, or an unrelated ' +
  'aside). If told no plan is currently active, always return false.\n\n' +
  `6. matchedPlanTemplate: if told no plan is currently active AND the request is involved enough ` +
  `to warrant a durable, tracked plan (decomposes into several sub-tasks toward one of the named ` +
  `kinds below), return the single best-matching name from: ${listTemplateNames().join(', ')}. ` +
  'Otherwise return null. If told a plan is already active, always return null.\n\n' +
  'Respond with JSON only, matching this shape exactly: {"riskLevel": "LOW"|"MEDIUM"|"HIGH", ' +
  '"riskReason": string, "isTrivial": boolean, "decomposedTasks": [{"id": string, "description": ' +
  'string, "depends_on": string[]}], "isReminderRequest": boolean, "isBulkReminderRequest": boolean, ' +
  '"isAbandonRequest": boolean, "matchedPlanTemplate": string|null}'

interface RawTurnIntent {
  riskLevel?: unknown
  riskReason?: unknown
  isTrivial?: unknown
  decomposedTasks?: unknown
  isReminderRequest?: unknown
  isBulkReminderRequest?: unknown
  isAbandonRequest?: unknown
  matchedPlanTemplate?: unknown
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

function parseTurnIntent(content: string, context: TurnIntentContext): TurnIntentClassification | null {
  const parsed = JSON.parse(content) as RawTurnIntent
  if (parsed.riskLevel !== 'HIGH' && parsed.riskLevel !== 'MEDIUM' && parsed.riskLevel !== 'LOW') return null
  if (typeof parsed.isTrivial !== 'boolean') return null
  if (typeof parsed.isReminderRequest !== 'boolean') return null
  if (typeof parsed.isBulkReminderRequest !== 'boolean') return null
  if (typeof parsed.isAbandonRequest !== 'boolean') return null
  if (parsed.matchedPlanTemplate !== null && typeof parsed.matchedPlanTemplate !== 'string') return null

  const riskReason = typeof parsed.riskReason === 'string' && parsed.riskReason.trim() ? parsed.riskReason : `LLM classified this as ${parsed.riskLevel} risk.`
  const decomposedTasksRaw = Array.isArray(parsed.decomposedTasks) ? parsed.decomposedTasks.filter(isDecomposedTaskSpec) : []
  const decomposedTasks = decomposedTasksRaw.length > 1 ? decomposedTasksRaw : null

  const isTrivial = parsed.riskLevel === 'LOW' && parsed.isTrivial
  const isBulkReminderRequest = parsed.isReminderRequest && parsed.isBulkReminderRequest
  const isAbandonRequest = context.hasActivePlan && parsed.isAbandonRequest
  const matchedPlanTemplate =
    !context.hasActivePlan && typeof parsed.matchedPlanTemplate === 'string' && listTemplateNames().includes(parsed.matchedPlanTemplate)
      ? parsed.matchedPlanTemplate
      : null

  return {
    riskLevel: parsed.riskLevel,
    riskReason,
    requiresApproval: parsed.riskLevel === 'HIGH' || isBulkReminderRequest,
    isTrivial,
    decomposedTasks,
    isReminderRequest: parsed.isReminderRequest,
    isBulkReminderRequest,
    isAbandonRequest,
    matchedPlanTemplate,
  }
}

/**
 * Runs the single consolidated LLM call every turn (replacing the old lexical-gate-then-maybe-
 * LLM-call chain) and derives all five downstream judgments from one structured response. Falls
 * back to the same safe defaults each former classifier fell back to individually on any parse
 * failure or LLM error: LOW risk / not trivial / no decomposition / no abandon / no template match
 * — i.e. "do the careful thing" (run the full harness, don't auto-approve, don't auto-abandon).
 */
export async function classifyTurnIntent(
  message: string,
  llmClient: ILLMClient,
  context: TurnIntentContext,
  model?: string,
  onUsage?: (usage: TokenUsage) => void,
): Promise<TurnIntentClassification> {
  try {
    const contextNote = context.hasActivePlan
      ? 'An active multi-step plan is currently running for this user.'
      : 'No plan is currently active for this user.'
    const response = await llmClient.callChatStructured(
      [
        { role: 'system', content: `${TURN_INTENT_SYSTEM_PROMPT}\n\n${contextNote}` },
        { role: 'user', content: message },
      ],
      undefined,
      { model, onUsage, structuredOutput: { schema: TURN_INTENT_SCHEMA } },
    )
    return parseTurnIntent(response.content, context) ?? failSafeClassification()
  } catch {
    return failSafeClassification()
  }
}
