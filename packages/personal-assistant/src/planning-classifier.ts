import type { DecomposedTaskSpec } from './decomposition-classifier.js'
import { matchTemplateIfConfident } from './plan-templates/index.js'

export interface PlanningCandidateClassification {
  isCandidate: boolean
  matchedTemplate: string | null
  reason: string
}

// Below this many decomposed tasks, a request is an ordinary compound turn, not
// something worth a durable, tracked plan — see decomposition-classifier.ts for
// the (already-paid-for) decomposition this reuses.
const PLAN_TASK_COUNT_THRESHOLD = 4

/**
 * Zero-additional-LLM-call gate deciding whether a request is "involved enough"
 * to warrant templated planning (plan-builder.ts) instead of the ad hoc task
 * graph decomposeObjective already produced. Reuses that call's own output rather
 * than spending a second one — same "don't pay for a call the cheap gate didn't
 * justify" discipline as classifyDecompositionCandidate.
 *
 * Candidate only when BOTH a confident template-keyword match exists AND the
 * message decomposed into at least PLAN_TASK_COUNT_THRESHOLD tasks. Either
 * condition alone is insufficient: a message that merely mentions "plan" once
 * but decomposes into 2 tasks is an ordinary compound request, and a 5-task
 * decomposition with no template keyword hit is just a long checklist, not a
 * named-plan-shaped effort. Fails closed toward "not a candidate" — a false
 * negative here just falls through to the existing decomposition path, no
 * capability is lost.
 */
export function classifyPlanningCandidate(
  message: string,
  decomposed: DecomposedTaskSpec[] | null,
): PlanningCandidateClassification {
  const matchedTemplate = matchTemplateIfConfident(message)
  const taskCount = decomposed?.length ?? 0

  if (!matchedTemplate) {
    return { isCandidate: false, matchedTemplate: null, reason: 'no confident template-keyword match' }
  }
  if (taskCount < PLAN_TASK_COUNT_THRESHOLD) {
    return {
      isCandidate: false,
      matchedTemplate: null,
      reason: `matched "${matchedTemplate}" but only ${taskCount} decomposed task(s) — not worth a durable plan`,
    }
  }
  return {
    isCandidate: true,
    matchedTemplate,
    reason: `matched the "${matchedTemplate}" template and decomposed into ${taskCount} tasks`,
  }
}
