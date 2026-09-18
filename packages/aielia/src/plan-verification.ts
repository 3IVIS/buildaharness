import type { ILLMClient, TokenUsage } from '@buildaharness/runtime'
import type { PlanTaskRecord } from './plan-store.js'

/**
 * P6 of plans/ask_question_and_plan_mode_plan.html — runs between drafting (P1/P3) and staging
 * for approval (P2). Two independent checks, deliberately ordered cheapest-and-most-certain
 * first: (1) dependency-graph validity (pure, synchronous, no LLM call — the same three checks
 * `adapter/harness/task_graph.py`'s `validate_task_graph` runs Python-side: orphaned `depends_on`
 * references and cycle detection via the identical iterative-DFS WHITE/GRAY/BLACK algorithm, plus
 * a duplicate-task-id check this phase's Scope calls for that the Python original doesn't need
 * because `TaskGraph` construction already dedupes by id), then (2) one bounded LLM call for the
 * harder judgment — a lighter, narrower version of `reviewer.py`'s three-lens shape, specifically
 * the adversarial lens's question. A graph error is a fails-fast condition (the plan must not
 * reach `awaiting_approval` with an invalid structure); an LLM-lens failure is not — it just means
 * the plan proceeds to approval without `reviewNotes` (Validation section, LLM-failure fallback).
 */

export function validatePlanTaskGraph(tasks: PlanTaskRecord[]): string[] {
  const errors: string[] = []
  const ids = new Set(tasks.map((t) => t.id))

  const seen = new Set<string>()
  for (const t of tasks) {
    if (seen.has(t.id)) errors.push(`Duplicate task id: '${t.id}'`)
    seen.add(t.id)
  }

  for (const t of tasks) {
    for (const depId of t.depends_on) {
      if (!ids.has(depId)) errors.push(`Task '${t.id}' depends_on unknown task '${depId}'`)
    }
  }

  // Cycle detection via iterative DFS (WHITE=0, GRAY=1, BLACK=2) — mirrors
  // adapter/harness/task_graph.py's validate_task_graph exactly, just ported to TS.
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const colour = new Map<string, number>()
  for (const id of ids) colour.set(id, WHITE)
  const adj = new Map<string, string[]>()
  for (const t of tasks) adj.set(t.id, t.depends_on)

  function hasCycleFrom(start: string): boolean {
    const stack: { node: string; children: string[]; idx: number }[] = [{ node: start, children: adj.get(start) ?? [], idx: 0 }]
    colour.set(start, GRAY)
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      if (frame.idx < frame.children.length) {
        const child = frame.children[frame.idx]
        frame.idx++
        if (!colour.has(child)) continue // orphaned ref, already reported above
        if (colour.get(child) === GRAY) return true
        if (colour.get(child) === WHITE) {
          colour.set(child, GRAY)
          stack.push({ node: child, children: adj.get(child) ?? [], idx: 0 })
        }
      } else {
        colour.set(frame.node, BLACK)
        stack.pop()
      }
    }
    return false
  }

  const cycleReported = new Set<string>()
  for (const id of ids) {
    if (colour.get(id) === WHITE) {
      if (hasCycleFrom(id) && !cycleReported.has(id)) {
        errors.push(`Dependency cycle detected involving task '${id}'`)
        cycleReported.add(id)
      }
    }
  }

  return errors
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: { type: 'string' } },
  },
  required: ['findings'],
}

function buildVerifySystemPrompt(): string {
  return (
    'You are reviewing a drafted plan before it is shown to the user for approval — you have no ' +
    'tools, only the plan below. Ask yourself the adversarial-lens question: would completing ' +
    'every listed task actually satisfy the stated success criteria? What, if anything, is ' +
    'missing (a necessary step the plan omits) or extraneous (a task that does not serve the ' +
    'success criteria)? Respond with JSON only, no prose: {"findings": string[]}. Each entry is ' +
    'one short, concrete finding. Return an empty array if the plan looks complete and correctly ' +
    'scoped — do not invent findings just to have something to say.'
  )
}

function describePlanForVerification(tasks: PlanTaskRecord[], successCriteria: string, rationale: string): string {
  const lines = tasks.map((t) => `- id: ${t.id}; ${t.description}; depends_on: [${t.depends_on.join(', ')}]; risk: ${t.riskLevel ?? 'LOW'}`)
  return `Success criteria: ${successCriteria}\nRationale: ${rationale}\nTasks:\n${lines.join('\n')}`
}

/**
 * The one bounded LLM call this phase adds. Any failure (thrown error, malformed JSON, wrong
 * shape) resolves to an empty findings array rather than propagating — this call is a quality
 * enhancement, not a gate, so it must never be the reason a plan fails to reach approval
 * (Validation section, LLM-failure fallback).
 */
async function reviewPlanForCompleteness(
  llmClient: ILLMClient,
  tasks: PlanTaskRecord[],
  successCriteria: string,
  rationale: string,
  model: string | undefined,
  onUsage: ((usage: TokenUsage) => void) | undefined,
): Promise<string[]> {
  try {
    const response = await llmClient.callChatStructured(
      [
        { role: 'system', content: buildVerifySystemPrompt() },
        { role: 'user', content: describePlanForVerification(tasks, successCriteria, rationale) },
      ],
      undefined,
      { model, onUsage, structuredOutput: { schema: VERIFY_SCHEMA } },
    )
    const parsed = JSON.parse(response.content) as { findings?: unknown }
    if (!Array.isArray(parsed.findings)) return []
    return parsed.findings.filter((f): f is string => typeof f === 'string')
  } catch {
    return []
  }
}

export type PlanVerificationOutcome =
  | { kind: 'graph_invalid'; errors: string[] }
  | { kind: 'verified'; reviewNotes: string[]; verifiedAt: string }

/**
 * Deterministic checks first (fails fast on a structural problem — the caller must not stage a
 * plan whose graph is invalid), then the bounded adversarial-completeness LLM call. Called from
 * `PlanDraftingService.draftTurn` right before handing a `readyForApproval` draft to
 * `PlanApprovalService.stageAndRespond`.
 */
export async function verifyPlanDraft(
  llmClient: ILLMClient,
  tasks: PlanTaskRecord[],
  successCriteria: string,
  rationale: string,
  model?: string,
  onUsage?: (usage: TokenUsage) => void,
): Promise<PlanVerificationOutcome> {
  const graphErrors = validatePlanTaskGraph(tasks)
  if (graphErrors.length > 0) return { kind: 'graph_invalid', errors: graphErrors }

  const reviewNotes = await reviewPlanForCompleteness(llmClient, tasks, successCriteria, rationale, model, onUsage)
  return { kind: 'verified', reviewNotes, verifiedAt: new Date().toISOString() }
}
