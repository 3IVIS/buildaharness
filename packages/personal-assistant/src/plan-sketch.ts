import type { ILLMClient, TokenUsage } from '@buildaharness/runtime'

/**
 * P9 of plans/ask_question_and_plan_mode_plan.html — the lightweight plan-sketch delegate's one
 * bounded LLM call. Deliberately the cheapest possible shape: a single plain-text reply the
 * caller shows directly in the chat, not a structured task list staged anywhere — there is no
 * PlanRecord, no PlanTaskRecord, nothing for P2's approval gate to see (INV-35). Distinct from
 * plan-drafting.ts's draftPlanRevision, which is the first call in an iterative, stateful,
 * eventually-approved drafting loop; this is one-shot advice, thrown away the moment the reply
 * is shown — there is no "revise the sketch" follow-up call, no running draft to revise.
 */
export interface PlanSketchResult {
  reply: string
}

function buildSystemPrompt(): string {
  return (
    'The user wants a quick, lightweight sketch of how you would approach a request — advice, ' +
    'not a commitment to execute anything. You have NO tools in this call; any grounding context ' +
    'supplied below already reflects a best-effort read of real repo state gathered separately. ' +
    'Reply in plain text with a short proposed task list (a handful of concrete steps, ' +
    'referencing real files/areas when the grounding context supports it) plus one sentence on ' +
    'the overall approach and any real risks or open questions worth flagging. Make your own best ' +
    'judgment call on anything ambiguous rather than asking a clarifying question — this is a ' +
    'one-shot sketch, not a conversation. Do not claim this plan is staged, approved, or about to ' +
    'run — say plainly that it is a sketch for the user to react to, not something you have done ' +
    'or are about to do.'
  )
}

/** Renders the grounding findings as one extra message so the model can reference real repo state without re-deriving it — same shape plan-drafting.ts's groundingContext handling uses. */
function groundingMessage(groundingContext: string): { role: 'user'; content: string } {
  return { role: 'user', content: `Grounding — real repo state found while preparing this sketch:\n${groundingContext}` }
}

/**
 * Spends one real LLM call sketching a plan for `request` — same "malformed/incomplete output is
 * the expected failure mode, not the edge case" fallback plan-drafting.ts's draftPlanRevision
 * uses: any thrown error, or an empty reply, returns null so the caller can show a generic
 * "couldn't sketch that" message instead of an empty bubble.
 */
export async function sketchPlan(
  llmClient: ILLMClient,
  request: string,
  groundingContext: string | undefined,
  model: string | undefined,
  onUsage: ((usage: TokenUsage) => void) | undefined,
): Promise<PlanSketchResult | null> {
  try {
    const messages = [
      { role: 'system' as const, content: buildSystemPrompt() },
      ...(groundingContext ? [groundingMessage(groundingContext)] : []),
      { role: 'user' as const, content: request },
    ]
    const reply = await llmClient.callChatSync(messages, { model, onUsage })
    const trimmed = reply.trim()
    if (!trimmed) return null
    return { reply: trimmed }
  } catch {
    return null
  }
}
