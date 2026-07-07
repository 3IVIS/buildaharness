import type { ILLMClient, TokenUsage } from '@buildaharness/runtime'

export interface DecompositionCandidateClassification {
  isCandidate: boolean
  reason: string
}

// Sequencing markers are a strong signal on their own; word count is a weaker,
// backstop signal for long requests that don't use any of these words but are
// still probably multi-step. Fails closed toward "not a candidate" — the
// opposite conservatism of triviality-classifier.ts, since being wrong here
// only costs a classification, not a skipped safety layer.
const SEQUENCING_MARKERS = /\b(then|after that|and then|next,|step \d|first[,:]|finally,)\b/i
const WORD_LIMIT = 40

/** Zero-LLM-call gate deciding whether a request is worth spending decomposeObjective's extra call on. */
export function classifyDecompositionCandidate(message: string): DecompositionCandidateClassification {
  const trimmed = message.trim()
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length

  if (SEQUENCING_MARKERS.test(trimmed)) {
    return { isCandidate: true, reason: 'contains a sequencing marker (then/first/next/step ...)' }
  }
  if (wordCount > WORD_LIMIT) {
    return { isCandidate: true, reason: `long request (${wordCount} words) — worth checking for multiple steps` }
  }
  return { isCandidate: false, reason: 'no sequencing markers and short enough to be one step' }
}

export interface DecomposedTaskSpec {
  id: string
  description: string
  depends_on: string[]
}

const DECOMPOSITION_SCHEMA = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          description: { type: 'string' },
          depends_on: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'description', 'depends_on'],
      },
    },
  },
  required: ['tasks'],
}

const DECOMPOSITION_SYSTEM_PROMPT =
  "Decompose the user's request into a short, ordered list of concrete sub-tasks. If the request is really just " +
  'one step, return a single task. Respond with JSON only, no prose: {"tasks":[{"id": string, "description": ' +
  'string, "depends_on": string[]}]}. `id` values must be unique; `depends_on` lists the ids of tasks that must ' +
  'complete first (usually just the previous task, or empty for the first one).'

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

/**
 * Spends one real LLM call decomposing `message` into multiple sub-tasks — only
 * call this for a request classifyDecompositionCandidate already flagged, so
 * ordinary single-step turns never pay for it. Malformed/incomplete JSON is the
 * expected failure mode here, not the edge case: any parse failure or a
 * single-task result returns null, meaning "fall back to the caller's own
 * single-task graph" rather than throwing.
 */
export async function decomposeObjective(
  llmClient: ILLMClient,
  message: string,
  model?: string,
  onUsage?: (usage: TokenUsage) => void,
): Promise<DecomposedTaskSpec[] | null> {
  try {
    const response = await llmClient.callChatStructured(
      [
        { role: 'system', content: DECOMPOSITION_SYSTEM_PROMPT },
        { role: 'user', content: message },
      ],
      undefined,
      { model, onUsage, structuredOutput: { schema: DECOMPOSITION_SCHEMA } },
    )
    const parsed = JSON.parse(response.content) as { tasks?: unknown }
    if (!Array.isArray(parsed.tasks)) return null
    const tasks = parsed.tasks.filter(isDecomposedTaskSpec)
    if (tasks.length <= 1) return null
    return tasks
  } catch {
    return null
  }
}
