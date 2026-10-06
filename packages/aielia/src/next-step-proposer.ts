import type { ILLMClient, TokenUsage } from '@buildaharness/runtime'
import type { GoalThread } from './goal-graph-store.js'
import type { GoalGraphSuggestMode } from './goal-graph-suggest-flag.js'
import type { NextStepContext } from './next-step-context.js'
import { parseModelJson } from './model-json.js'

// Phase 6 of plans/hierarchical_goal_tree_and_steering_plan.html — Tier 1.5's "next-step
// proposer" (R7): when a GoalThread reaches DONE, propose plausible next steps as persistent
// advisory nodes rather than an ephemeral chat summary. Standalone utility, self-contained (no
// import coupling into goal-graph-store.ts beyond the read-only GoalThread type — same
// "no import coupling" discipline Phase 1's GoalTaskRecord used against plan-store.ts's
// PlanTaskRecord), unused until a later phase wires proposeNextSteps()'s output into the
// persisted GoalGraphRecord and a review surface (Phase 7).

export type SuggestionConfidence = 'high' | 'medium' | 'low'

/** Mirrors `shouldAutoPromote()`'s three-way policy *shape* (memory-service.ts) — not its bands, since Q10 found no numeric threshold to reuse: `high` auto-promotes, `medium` queues for explicit confirmation, `low` stays advisory-only and is never persisted past the turn that produced it. */
export type SuggestionPromotion = 'auto' | 'pending_confirm' | 'session_only'

export interface NextStepSuggestion {
  /** A concrete, actionable next step description — third person, e.g. "add tests for the login page". */
  description: string
  confidence: SuggestionConfidence
  /** Why this follows from the completed goal — surfaced to the user alongside the suggestion, same spirit as StatedFact's rationale-free text but here always populated since a suggestion needs justification a stated fact doesn't. */
  rationale: string
}

/**
 * A persistent advisory node (R7) — `proposeNextSteps()`'s per-suggestion output, carrying the
 * promotion decision alongside the LLM's own judgment. Self-contained rather than a
 * `GoalTaskRecord`: a suggestion isn't yet a task on any thread (it may never be promoted at all,
 * see `session_only`), so it deliberately doesn't reuse that shape.
 */
export interface SuggestedNextStepNode {
  id: string
  goalThreadId: string
  description: string
  rationale: string
  confidence: SuggestionConfidence
  promotion: SuggestionPromotion
  createdAt: string
}

const EMPTY_SUGGESTIONS: NextStepSuggestion[] = []

const NEXT_STEP_SCHEMA = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          rationale: { type: 'string' },
        },
        required: ['description', 'confidence', 'rationale'],
      },
    },
  },
  required: ['suggestions'],
}

const SYSTEM_PROMPT =
  'A goal the user was working on with a personal assistant has just completed. Given the goal\'s ' +
  'stated success criteria, rationale, and its finished tasks, propose 0-3 concrete, actionable ' +
  'next steps a reasonable person would plausibly want to do next as a direct continuation of this ' +
  'specific completed work — not generic advice applicable to any project. Return an empty list if ' +
  'nothing concrete and specific follows from this particular goal. The input may also carry the ' +
  'bigger picture: `earlierConversation` (what was discussed before), `stepsTaken` (files read or ' +
  'searches made) and `goalGraph` (every goal the session tracks, with task statuses; the entry ' +
  'marked `focus` is the one just finished; a goal\'s `openSuggestions` are next steps proposed for it when it finished, which the earlier conversation may or may not show as done). Use it: prefer a next step that follows from ' +
  'something raised earlier or from a goal that is still open, and do not propose work that an ' +
  'earlier turn or a finished goal already covers; when the user has moved on to something unrelated, an earlier goal\'s still-relevant `openSuggestions` are a good thing to offer going back to. For each suggestion, judge ' +
  '`confidence` against an observable criterion, not a vague guess: `high` if the next step was ' +
  'explicitly mentioned or clearly implied as follow-up work by the user or the goal\'s own success ' +
  'criteria/rationale (e.g. tests were named as pending, a stated multi-part request\'s remaining ' +
  'part); `medium` if it is a reasonable, common-practice extension of the completed work but was ' +
  'never stated or implied by the user (e.g. suggesting tests when none were mentioned at all); ' +
  '`low` if it is speculative or only loosely tied to the specific completed work (e.g. generic ' +
  '"consider refactoring" advice). `rationale` states in one sentence why this step follows from ' +
  'the completed goal. Write `description` and `rationale` in the language named in `writeIn`. Respond with JSON only: {"suggestions": [{"description": string, ' +
  '"confidence": "high"|"medium"|"low", "rationale": string}]}'

/**
 * Appended for turn-end options only. Each option is a message the user could send as-is, so
 * meta-instructions ("reply to the assistant with...") are not options; and when the reply itself
 * asks the user to choose among enumerated options, those options are the suggestions (the user
 * clicks instead of retyping). Options an earlier turn proposed are only offered again when this
 * turn's reply makes them relevant, so chips do not carry stale suggestions forward.
 */
const TURN_END_ADDENDUM =
  ' These are shown as clickable options under the assistant\'s latest reply, and picking one puts its ' +
  '`description` in the user\'s message box. So write each `description` as the message the user would ' +
  'send, in first person or as a direct request (e.g. "Compare the second and third options"), never ' +
  'an instruction about what to say ("Reply to the assistant with...") and never advice for the user. ' +
  'If the latest reply ends by asking the user to choose among enumerated options or angles, return ' +
  'those options (one per suggestion, `high` confidence) instead of anything else. Base the options ' +
  'on the latest reply: do not repeat a goal\'s earlier `openSuggestions` unless this reply makes ' +
  'them relevant again.'

const ENGLISH_WORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'to', 'of', 'and', 'in', 'it', 'this', 'that', 'what', 'how', 'why', 'do', 'does', 'did', 'can', 'run', 'fix', 'add', 'for', 'with', 'my', 'me', 'you', 'please', 'any', 'there', 'now', 'again', 'ok', 'go', 'on', 'not', 'i'])

/**
 * Names the language the suggestions must be written in. The model drifted into Chinese, Spanish or French
 * on English conversations when it was only told to "match the user's language", so English is named
 * outright when the user's own text clearly is English (two distinct common English words); anything else
 * keeps the generic instruction.
 */
export function suggestionLanguage(userTexts: string[]): string {
  const seen = new Set<string>()
  for (const w of userTexts.join(' ').toLowerCase().match(/[a-z']+/g) ?? []) if (ENGLISH_WORDS.has(w)) seen.add(w)
  return seen.size >= 2 ? 'English' : "the language of the user's own messages"
}

function isSuggestion(value: unknown): value is NextStepSuggestion {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.description === 'string' &&
    v.description !== '' &&
    (v.confidence === 'high' || v.confidence === 'medium' || v.confidence === 'low') &&
    typeof v.rationale === 'string'
  )
}

/**
 * One bounded LLM call per DONE thread (caller decides when — see `proposeNextSteps()`). Falls
 * back to an empty list on any parse failure or LLM error, same fail-safe direction as
 * `matchGoalIdentity`/`classifyTurnIntent`: a missed suggestion costs nothing worse than the user
 * not being proactively reminded, never a wrong or fabricated next step.
 */
async function generateNextStepSuggestions(
  context: { successCriteria: string; rationale: string; tasks: string[] },
  bigPicture: NextStepContext | undefined,
  llmClient: ILLMClient,
  model?: string,
  onUsage?: (usage: TokenUsage) => void,
  turnEnd = false,
): Promise<NextStepSuggestion[]> {
  try {
    const response = await llmClient.callChatStructured(
      [
        { role: 'system', content: turnEnd ? SYSTEM_PROMPT + TURN_END_ADDENDUM : SYSTEM_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            writeIn: suggestionLanguage([
              context.successCriteria,
              ...(bigPicture?.conversation ?? []).filter((t) => t.role === 'user').map((t) => t.content),
            ]),
            ...context,
            ...(bigPicture?.conversation ? { earlierConversation: bigPicture.conversation } : {}),
            ...(bigPicture?.stepsThisTurn ? { stepsTaken: bigPicture.stepsThisTurn } : {}),
            ...(bigPicture?.goals ? { goalGraph: bigPicture.goals } : {}),
          }),
        },
      ],
      undefined,
      { model, onUsage, structuredOutput: { schema: NEXT_STEP_SCHEMA } },
    )
    const parsed = parseModelJson(response.content) as { suggestions?: unknown }
    return Array.isArray(parsed.suggestions) ? parsed.suggestions.filter(isSuggestion) : EMPTY_SUGGESTIONS
  } catch {
    return EMPTY_SUGGESTIONS
  }
}

/** Q10's three-way policy shape, applied to this mechanism's own confidence rubric — see this module's doc comment on why the bands aren't reused from `shouldAutoPromote()`. */
export function classifySuggestionPromotion(confidence: SuggestionConfidence): SuggestionPromotion {
  if (confidence === 'high') return 'auto'
  if (confidence === 'medium') return 'pending_confirm'
  return 'session_only'
}

/**
 * Tier 1.5's entry point (R7): proposes next-step nodes for `thread`, gated by
 * `goalGraphSuggestMode` independently of `goalGraphMode` (Q8) — returns `[]` without any LLM call
 * both when the flag is off (INV-43: a flag-off session sees zero behavior change) and when
 * `thread` hasn't actually reached `DONE` yet, since a suggestion only makes sense once the goal
 * it follows from is finished.
 */
export async function proposeNextSteps(
  thread: GoalThread,
  llmClient: ILLMClient,
  suggestMode: GoalGraphSuggestMode,
  model?: string,
  onUsage?: (usage: TokenUsage) => void,
  bigPicture?: NextStepContext,
): Promise<SuggestedNextStepNode[]> {
  if (suggestMode !== 'enabled') return []
  if (thread.status !== 'DONE') return []

  const suggestions = await generateNextStepSuggestions(
    { successCriteria: thread.successCriteria, rationale: thread.rationale, tasks: thread.tasks.map((t) => t.description) },
    bigPicture,
    llmClient,
    model,
    onUsage,
  )
  const now = new Date().toISOString()
  return suggestions.map((s) => ({
    id: crypto.randomUUID(),
    goalThreadId: thread.id,
    description: s.description,
    rationale: s.rationale,
    confidence: s.confidence,
    promotion: classifySuggestionPromotion(s.confidence),
    createdAt: now,
  }))
}

const CONFIDENCE_ORDER: Record<SuggestionConfidence, number> = { high: 0, medium: 1, low: 2 }

/**
 * The turn-end entry point: after a full (non-trivial) turn completes, propose up to three
 * concrete next steps for the user to pick from — shown under the reply, like Claude Code's prompt
 * suggestions. Same bounded call and confidence rubric as `proposeNextSteps` (the turn's request
 * stands in for the thread's success criteria, the reply for its rationale), gated by
 * `goalGraphSuggestMode`. Returns `[]` without any LLM call when the mode isn't 'enabled' or there
 * is nothing to follow up on. Ordered most-confident first and capped at three; unlike thread
 * suggestions nothing here is persisted — a turn-end option is advisory for the turn that produced
 * it, so every confidence tier (including `low`, `session_only` in the thread policy) is shown.
 */
export async function proposeTurnNextSteps(
  turn: { userMessage: string; reply: string },
  llmClient: ILLMClient,
  suggestMode: GoalGraphSuggestMode,
  model?: string,
  onUsage?: (usage: TokenUsage) => void,
  bigPicture?: NextStepContext,
): Promise<NextStepSuggestion[]> {
  if (suggestMode !== 'enabled') return []
  if (turn.userMessage.trim() === '' || turn.reply.trim() === '') return []
  const suggestions = await generateNextStepSuggestions(
    { successCriteria: turn.userMessage, rationale: turn.reply.slice(0, 1500), tasks: [] },
    bigPicture,
    llmClient,
    model,
    onUsage,
    true,
  )
  return [...suggestions].sort((a, b) => CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence]).slice(0, 3)
}
