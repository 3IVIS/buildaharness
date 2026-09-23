import type { ILLMClient, TokenUsage } from '@buildaharness/runtime'

// Phase 4 of plans/hierarchical_goal_tree_and_steering_plan.html — R4's scope×urgency classifier.
// Every incoming mid-task steering message (drained from a LiveSteeringChannel, Phase 3) is
// classified along two independent axes before it's folded into the running turn: how it relates
// to the task in flight (scope relation), and how urgently it should be handled (urgency). This is
// the "Classification policy" table of the plan turned into code — see that table for the full
// per-branch handling this feeds (goal-graph-reconcile.ts, Phase 4's other half).

export type ScopeRelation = 'SAME_TASK' | 'SAME_GOAL_NEW_TASK' | 'NEW_GOAL' | 'CANCEL_CURRENT'
export type Urgency = 'IMMEDIATE' | 'DEFERRED'

export interface ScopeUrgencyClassification {
  scopeRelation: ScopeRelation
  urgency: Urgency
}

/** What the classifier is given to judge scope against — the best available proxy for "the task/goal in flight" this phase has: the active GoalThread's own successCriteria/rationale, not a live per-task pointer (that's Phase 5's Scheduler territory). */
export interface ScopeUrgencyContext {
  currentGoalDescription: string | null
}

const SCOPE_RELATIONS: ScopeRelation[] = ['SAME_TASK', 'SAME_GOAL_NEW_TASK', 'NEW_GOAL', 'CANCEL_CURRENT']
const URGENCIES: Urgency[] = ['IMMEDIATE', 'DEFERRED']

/**
 * INV-41 — on classifier uncertainty (a malformed response, an LLM error, or an unrecognized enum
 * value), default to SAME_GOAL_NEW_TASK × DEFERRED rather than a neutral coin flip. Same fail-safe
 * philosophy as turn-intent-classifier.ts's UNKNOWN → requiresApproval, but a different asymmetry
 * (see the plan's "Fail-safe default" section): a wrongly-deferred request costs the user one
 * clarifying nudge later, a wrongly-preempted task costs the work already in flight — bias toward
 * "queue it, don't switch."
 */
export const FAIL_SAFE_CLASSIFICATION: ScopeUrgencyClassification = { scopeRelation: 'SAME_GOAL_NEW_TASK', urgency: 'DEFERRED' }

const SCOPE_URGENCY_SCHEMA = {
  type: 'object',
  properties: {
    scopeRelation: { enum: SCOPE_RELATIONS },
    urgency: { enum: URGENCIES },
  },
  required: ['scopeRelation', 'urgency'],
}

const SYSTEM_PROMPT =
  'A task is currently executing for a user and a new message just arrived mid-task. Classify the ' +
  'new message along two independent axes. You are given "message" (the new text) and ' +
  '"currentGoal" (a short description of the goal currently being worked on, or null if none is ' +
  'known). scopeRelation — one of: "SAME_TASK" (corrects or refines the task currently in flight — ' +
  'e.g. adds a constraint to what\'s already being done), "SAME_GOAL_NEW_TASK" (a new step under ' +
  'the same overall goal that does not touch the task currently in flight), "NEW_GOAL" (unrelated ' +
  'to the current goal entirely — a different objective), "CANCEL_CURRENT" (an explicit signal to ' +
  'abandon/stop the current task or goal, e.g. "never mind", "stop", "forget that"). urgency — one ' +
  'of: "IMMEDIATE" (should be acted on right away) or "DEFERRED" (can wait until the current task ' +
  'finishes). On genuine uncertainty, prefer "SAME_GOAL_NEW_TASK" and "DEFERRED" — do not guess a ' +
  'more disruptive classification without clear evidence in the message. Respond with JSON only: ' +
  '{"scopeRelation": one of the four values above, "urgency": one of the two values above}.'

/**
 * One bounded LLM call per steering message — same callChatStructured shape as
 * matchGoalIdentity/checkForContradictions. SAME_TASK always collapses to IMMEDIATE regardless of
 * what the model reports for urgency (see the plan: "a deferred correction to the task you're
 * already on isn't really a correction"). Any parse failure, thrown error, or unrecognized enum
 * value collapses to FAIL_SAFE_CLASSIFICATION (INV-41) — never thrown, never a silent default to a
 * more disruptive branch.
 */
export async function classifyScopeUrgency(
  message: string,
  context: ScopeUrgencyContext,
  llmClient: ILLMClient,
  model?: string,
  onUsage?: (usage: TokenUsage) => void,
): Promise<ScopeUrgencyClassification> {
  try {
    const response = await llmClient.callChatStructured(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify({ message, currentGoal: context.currentGoalDescription }) },
      ],
      undefined,
      { model, onUsage, structuredOutput: { schema: SCOPE_URGENCY_SCHEMA } },
    )
    const parsed = JSON.parse(response.content) as { scopeRelation?: unknown; urgency?: unknown }
    const scopeRelation = SCOPE_RELATIONS.includes(parsed.scopeRelation as ScopeRelation) ? (parsed.scopeRelation as ScopeRelation) : null
    const urgency = URGENCIES.includes(parsed.urgency as Urgency) ? (parsed.urgency as Urgency) : null
    if (!scopeRelation || !urgency) return FAIL_SAFE_CLASSIFICATION
    return { scopeRelation, urgency: scopeRelation === 'SAME_TASK' ? 'IMMEDIATE' : urgency }
  } catch {
    return FAIL_SAFE_CLASSIFICATION
  }
}
