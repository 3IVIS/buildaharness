import type { ILLMClient, TokenUsage } from '@buildaharness/runtime'
import { listTemplateNames } from './plan-templates/index.js'
import type { DecomposedTaskSpec } from './decomposition-classifier.js'
import { classifyError } from './error-classifier.js'

/**
 * 'UNKNOWN' is never produced by a successful classification (TURN_INTENT_SCHEMA's riskLevel enum
 * only ever allows LOW/MEDIUM/HIGH from the model) — it exists solely as failSafeClassification's
 * fail-safe value, so callers can route a classifier failure to their most conservative branch
 * instead of silently treating it as LOW risk. See failSafeClassification's doc comment.
 */
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN'

export interface TurnIntentContext {
  /** Whether an active durable plan exists for this session — gates whether the abandon
   *  judgment means anything and whether plan-template matching should even be attempted
   *  (mirrors assistant.ts's own `if (activePlan) { ... } else { match a template } ` split). */
  hasActivePlan: boolean
}

export interface TurnIntentClassification {
  riskLevel: RiskLevel
  riskReason: string
  /** Computed here from riskLevel/isBulkReminderRequest for trace/display purposes and any
   *  caller that only wants the raw classifier verdict. Phase D3: no gating call site reads this
   *  field directly anymore — turn-interpreter.ts's approval gate and assistant.ts's
   *  execution-mode classification both recompute the decision from riskLevel/isBulkReminderRequest
   *  via turn-policy.ts's evaluateTurnPolicy() instead, so a future bug here can't silently change
   *  what those care about (INV-14). */
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
  /**
   * Set when the message states a durable/session fact about the user (name, preference,
   * health/dietary, current location/job, ...) — the LLM-backed backstop for
   * fact-extraction.ts's lexical FACT_MARKERS/HEALTH_OR_DIETARY_MARKERS, which have no fallback of
   * their own. assistant.ts only trusts this when the lexical pass found nothing for the same
   * message; the lexical path stays authoritative (and free) when it already matches.
   */
  statesDurableFact: { text: string; durable: boolean } | null
}

const FAIL_SAFE_REASON = 'Risk could not be determined — classification failed or returned an unusable result.'

/**
 * Fired on any classifier failure (LLM error, unparseable/malformed response) — see
 * classifyTurnIntent's try/catch and parseTurnIntent's null-return paths below. Deliberately does
 * NOT reuse the old LOW/no-approval defaults: a classifier failure means the risk is genuinely
 * unknown, not verified-safe, so this returns `riskLevel: 'UNKNOWN'` and `requiresApproval: true`
 * to route the turn to the caller's most conservative branch (assistant.ts's approval gate) rather
 * than silently letting a HIGH-risk request through under a false LOW verdict. `isTrivial: false`
 * is preserved from the old fallback — that part was already correct: it keeps the full harness
 * engaged on failure instead of taking the trivial-question fast path. The bug this fixes is
 * specifically the approval-gate default, not the harness-engagement default.
 *
 * `cause`, when provided (a genuine thrown error — either the LLM call itself, or
 * JSON.parse(content) throwing inside parseTurnIntent on unparseable content below; NOT set for a
 * structurally-valid-JSON-but-semantically-invalid response, e.g. an unrecognized riskLevel, which
 * parseTurnIntent handles by returning null rather than throwing and has no underlying error object
 * to classify), is run through error-classifier.ts's classifyError() and folded into riskReason.
 * Without this, a broken
 * CLAUDE_PATH (or any other spawn-shaped failure) silently discarded the real ENOENT error here
 * and surfaced only the generic FAIL_SAFE_REASON on every turn — error-classifier.ts's specific,
 * actionable "Couldn't find the Claude CLI..." message existed but was never reached, because this
 * consolidated classification call fails before the main conversational turn (which does route
 * errors through classifyError) ever runs. classifyError doesn't need a `backend` argument for the
 * ENOENT pattern this was found against, and PersonalAssistant has no backend concept to plumb in
 * anyway (it only ever sees an ILLMClient) — omitted here for that reason, same as elsewhere
 * classifyError is called without one.
 */
function failSafeClassification(cause?: unknown): TurnIntentClassification {
  return {
    riskLevel: 'UNKNOWN',
    riskReason: cause === undefined ? FAIL_SAFE_REASON : `${FAIL_SAFE_REASON} (${classifyError(cause).message})`,
    requiresApproval: true,
    isTrivial: false,
    decomposedTasks: null,
    isReminderRequest: false,
    isBulkReminderRequest: false,
    isAbandonRequest: false,
    matchedPlanTemplate: null,
    statesDurableFact: null,
  }
}

const TASK_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    description: { type: 'string' },
    depends_on: { type: 'array', items: { type: 'string' } },
    riskLevel: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
  },
  required: ['id', 'description', 'depends_on', 'riskLevel'],
}

const STATES_DURABLE_FACT_SCHEMA = {
  type: ['object', 'null'],
  properties: {
    text: { type: 'string' },
    durable: { type: 'boolean' },
  },
  required: ['text', 'durable'],
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
    statesDurableFact: STATES_DURABLE_FACT_SCHEMA,
  },
  required: [
    'riskLevel',
    'riskReason',
    'isTrivial',
    'decomposedTasks',
    'isReminderRequest',
    'isBulkReminderRequest',
    'isAbandonRequest',
    'matchedPlanTemplate',
    'statesDurableFact',
  ],
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
  "Classify the user's message across seven independent judgments, for a personal-assistant that " +
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
  'the first one). Each task also gets its own `riskLevel` (same HIGH/MEDIUM/LOW definitions as ' +
  'judgment 1, applied to that one sub-task alone) — a compound request can mix risk levels across ' +
  'its steps (e.g. "reply to the email, then delete the drafts folder" is LOW then HIGH), so do not ' +
  'just repeat the overall riskLevel for every task.\n\n' +
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
  '7. statesDurableFact: set only if the message states a durable or session-scoped fact about the ' +
  "user themselves (their name, a stated preference, an allergy/dietary restriction, their current " +
  'location or job, "remember that..." framing, ...) — not a question, request, or fact about ' +
  'something else. `text` is the fact restated concisely in the third person (e.g. "the user is ' +
  'allergic to peanuts"); `durable` is true only for identity/safety-relevant facts meant to persist ' +
  'indefinitely (name, stated preference, health/dietary) — false for something expected to change ' +
  '(current location, current job, one-off context). Otherwise return null.\n\n' +
  'Respond with JSON only, matching this shape exactly: {"riskLevel": "LOW"|"MEDIUM"|"HIGH", ' +
  '"riskReason": string, "isTrivial": boolean, "decomposedTasks": [{"id": string, "description": ' +
  'string, "depends_on": string[], "riskLevel": "LOW"|"MEDIUM"|"HIGH"}], "isReminderRequest": ' +
  'boolean, "isBulkReminderRequest": boolean, "isAbandonRequest": boolean, "matchedPlanTemplate": ' +
  'string|null, "statesDurableFact": {"text": string, "durable": boolean}|null}'

interface RawTurnIntent {
  riskLevel?: unknown
  riskReason?: unknown
  isTrivial?: unknown
  decomposedTasks?: unknown
  isReminderRequest?: unknown
  isBulkReminderRequest?: unknown
  isAbandonRequest?: unknown
  matchedPlanTemplate?: unknown
  statesDurableFact?: unknown
}

function isDecomposedTaskSpec(value: unknown): value is DecomposedTaskSpec {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === 'string' &&
    typeof v.description === 'string' &&
    (v.riskLevel === 'LOW' || v.riskLevel === 'MEDIUM' || v.riskLevel === 'HIGH') &&
    Array.isArray(v.depends_on) &&
    v.depends_on.every((d) => typeof d === 'string')
  )
}

/**
 * Drops any `depends_on` reference that doesn't name another task actually present in this same
 * decomposedTasks array — found live (convB, batch 93): the LLM returned a task "3" depending on
 * task "2" while never actually emitting a task "2" (either it never generated one, or
 * isDecomposedTaskSpec's shape filter just above dropped a malformed one that other tasks still
 * referenced by id). Left unsanitized, that dangling reference reached HarnessRuntime.run()'s
 * initialTasks unchanged, and validateTaskGraph (packages/harness) threw InvalidTaskGraphError —
 * which crashed the ENTIRE turn's finalization (transcript write, fact recording, plan update)
 * via assistant.ts's catch-and-rethrow, even though the draft reply had already been generated
 * and streamed correctly to the user. The user saw a fully correct answer immediately followed by
 * "Something went wrong ... Type the message again to retry", and nothing about that turn was
 * actually persisted. Dropping the dangling id (rather than discarding the whole decomposition)
 * is safe here specifically because every task in a decomposed turn executes against the same
 * single draftReply (see assistant.ts's toolExecutors comment) — depends_on only shapes the
 * harness's tracked task graph, not which content actually gets produced.
 */
function sanitizeDependsOn(tasks: DecomposedTaskSpec[]): DecomposedTaskSpec[] {
  const knownIds = new Set(tasks.map((t) => t.id))
  return tasks.map((t) => (t.depends_on.every((d) => knownIds.has(d)) ? t : { ...t, depends_on: t.depends_on.filter((d) => knownIds.has(d)) }))
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
  const decomposedTasks = decomposedTasksRaw.length > 1 ? sanitizeDependsOn(decomposedTasksRaw) : null

  const isTrivial = parsed.riskLevel === 'LOW' && parsed.isTrivial
  const isBulkReminderRequest = parsed.isReminderRequest && parsed.isBulkReminderRequest
  const isAbandonRequest = context.hasActivePlan && parsed.isAbandonRequest
  const matchedPlanTemplate =
    !context.hasActivePlan && typeof parsed.matchedPlanTemplate === 'string' && listTemplateNames().includes(parsed.matchedPlanTemplate)
      ? parsed.matchedPlanTemplate
      : null

  const rawFact = parsed.statesDurableFact
  const statesDurableFact =
    typeof rawFact === 'object' &&
    rawFact !== null &&
    typeof (rawFact as Record<string, unknown>).text === 'string' &&
    (rawFact as Record<string, unknown>).text !== '' &&
    typeof (rawFact as Record<string, unknown>).durable === 'boolean'
      ? { text: (rawFact as { text: string; durable: boolean }).text, durable: (rawFact as { text: string; durable: boolean }).durable }
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
    statesDurableFact,
  }
}

/**
 * Runs the single consolidated LLM call every turn (replacing the old lexical-gate-then-maybe-
 * LLM-call chain) and derives all seven downstream judgments from one structured response. Falls
 * back to failSafeClassification's conservative defaults on any parse failure or LLM error:
 * UNKNOWN risk requiring approval / not trivial / no decomposition / no abandon / no template
 * match / no stated fact — i.e. "do the careful thing" (run the full harness, require approval
 * rather than guessing LOW, don't auto-abandon, don't silently claim a fact was stated when the
 * call failed). Per-task riskLevel
 * (Phase 1 of plans/lexical_functions_hardening_plan.html) and statesDurableFact are this call's
 * LLM-backed backstops for what used to be pure-lexical, no-fallback judgments — risk-classifier.ts's
 * standalone per-task classifyRisk and fact-extraction.ts's FACT_MARKERS respectively — both of
 * which stay as the free, zero-latency first check; this call is only trusted when they find
 * nothing (see assistant.ts's call sites for exactly how each is gated).
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
  } catch (err) {
    return failSafeClassification(err)
  }
}
