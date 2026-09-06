import type { ILLMClient, TokenUsage } from '@buildaharness/runtime'
import type { SupervisorDirectiveData, TrajectoryDigestData } from '@buildaharness/harness'

/**
 * Trajectory Supervisor decider (S5 host wiring of
 * plans/harness_trajectory_supervisor_plan.html) — the single LLM call the harness makes
 * ONLY on the `cannotMakeProgress()` stall edge, wired here as the personal-assistant's
 * `HarnessRunOptions.supervisorDecider`. TS twin of adapter/harness/supervisor.py's
 * `decide_supervisor_directive()`.
 *
 * Given the bounded stall digest, return one directive from the closed enum. The harness's
 * own `resolveSupervisorDirective()` → `SupervisorDirective.fromJSON()` handles enum-safety,
 * payload-shape coercion, and length caps, so this only has to produce a best-effort object.
 *
 * Fail-safe: any LLM error, timeout, or unparseable body resolves to CONTINUE (the
 * deterministic recovery ladder) — never a more aggressive action. Same discipline as
 * turn-intent-classifier.ts's failSafeClassification() and checkForContradictions().
 */

const SYSTEM_PROMPT =
  'You are a trajectory supervisor for a long-running autonomous assistant. The run has ' +
  'STALLED — it is not making progress. You are given a bounded JSON digest of the trajectory ' +
  '(the goal, steps taken, why it stalled, strategies already tried, recurring failure classes, ' +
  'reopened tasks, open contradictions, and blocking unknowns). Choose the SINGLE cheapest ' +
  'intervention that could get it unstuck. You never make tactical decisions, only redirect. ' +
  'Respond with JSON only:\n' +
  '{"action": <one of "CONTINUE","REDIRECT_STRATEGY","REFRAME_PLAN","GATHER_EVIDENCE","ASK_USER",' +
  '"ABORT">, "rationale": string, "strategy_hint": string|null, "plan_note": string|null, ' +
  '"investigation": {"question": string, "suggested_tools": string[]}|null, ' +
  '"question": {"question": string, "options": string[]}|null}\n' +
  '- CONTINUE: let the deterministic recovery ladder proceed. Prefer this unless a targeted ' +
  'intervention is clearly better.\n' +
  '- REDIRECT_STRATEGY: switch approach now; put the concrete approach in "strategy_hint" (one of ' +
  'DIRECT_EDIT, TRACE_EXEC, BROADER_SEARCH, REIMPLEMENT, MINIMAL_FIX).\n' +
  '- REFRAME_PLAN: the whole task decomposition is wrong; describe the better framing in "plan_note".\n' +
  '- GATHER_EVIDENCE: a specific missing fact is blocking progress and a bounded read-only lookup ' +
  '(read a file, search) would resolve it; put the lookup in "investigation".\n' +
  '- ASK_USER: the task is genuinely ambiguous or needs a decision only the user can make; put the ' +
  'question (and any concrete choices) in "question". Use this sparingly — only when guessing would ' +
  'be wrong.\n' +
  '- ABORT: redirection is exhausted and the run is unrecoverable without new input.\n' +
  'Always include "rationale". Use null for fields that do not apply to your action.'

const SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['CONTINUE', 'REDIRECT_STRATEGY', 'REFRAME_PLAN', 'GATHER_EVIDENCE', 'ASK_USER', 'ABORT'],
    },
    rationale: { type: 'string' },
    strategy_hint: { type: ['string', 'null'] },
    plan_note: { type: ['string', 'null'] },
    investigation: {
      type: ['object', 'null'],
      properties: {
        question: { type: 'string' },
        suggested_tools: { type: 'array', items: { type: 'string' } },
      },
    },
    question: {
      type: ['object', 'null'],
      properties: {
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  required: ['action', 'rationale'],
}

export async function decideSupervisorDirective(
  digest: TrajectoryDigestData,
  llmClient: ILLMClient,
  model?: string,
  onUsage?: (usage: TokenUsage) => void,
): Promise<Partial<SupervisorDirectiveData> | null> {
  try {
    const response = await llmClient.callChatStructured(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(digest) },
      ],
      undefined,
      { model, onUsage, structuredOutput: { schema: SCHEMA } },
    )
    const parsed = JSON.parse(response.content) as Partial<SupervisorDirectiveData>
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null // fail-safe → CONTINUE
  }
}
