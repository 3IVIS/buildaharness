import type { ILLMClient, TokenUsage } from '@buildaharness/runtime'
import type { GoalThread } from './goal-graph-store.js'
import type { GoalGraphSuggestMode } from './goal-graph-suggest-flag.js'

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
  'nothing concrete and specific follows from this particular goal. For each suggestion, judge ' +
  '`confidence` against an observable criterion, not a vague guess: `high` if the next step was ' +
  'explicitly mentioned or clearly implied as follow-up work by the user or the goal\'s own success ' +
  'criteria/rationale (e.g. tests were named as pending, a stated multi-part request\'s remaining ' +
  'part); `medium` if it is a reasonable, common-practice extension of the completed work but was ' +
  'never stated or implied by the user (e.g. suggesting tests when none were mentioned at all); ' +
  '`low` if it is speculative or only loosely tied to the specific completed work (e.g. generic ' +
  '"consider refactoring" advice). `rationale` states in one sentence why this step follows from ' +
  'the completed goal. Respond with JSON only: {"suggestions": [{"description": string, ' +
  '"confidence": "high"|"medium"|"low", "rationale": string}]}'

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
  thread: GoalThread,
  llmClient: ILLMClient,
  model?: string,
  onUsage?: (usage: TokenUsage) => void,
): Promise<NextStepSuggestion[]> {
  try {
    const response = await llmClient.callChatStructured(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            successCriteria: thread.successCriteria,
            rationale: thread.rationale,
            tasks: thread.tasks.map((t) => t.description),
          }),
        },
      ],
      undefined,
      { model, onUsage, structuredOutput: { schema: NEXT_STEP_SCHEMA } },
    )
    const parsed = JSON.parse(response.content) as { suggestions?: unknown }
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
): Promise<SuggestedNextStepNode[]> {
  if (suggestMode !== 'enabled') return []
  if (thread.status !== 'DONE') return []

  const suggestions = await generateNextStepSuggestions(thread, llmClient, model, onUsage)
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
