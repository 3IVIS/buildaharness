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

// A comma-separated enumeration ("I need to research the company, prepare answers, pick out
// what to wear, and plan my route") is just as much a multi-step request as one using
// then/first/next — it just never uses any of those words. Found via live testing: a 4-subtask
// interview-prep request phrased this way (and landing at exactly 40 words, under WORD_LIMIT)
// fell through both signals, so decomposeObjective never ran and /layers reported "one eligible
// task" even though the model itself went on to create 4 separate reminders for it. At least 2
// commas before a closing "and"/"or" is a cheap, deliberately loose signal — a false positive here
// only costs one wasted decomposeObjective call (which itself falls back to a single task), the
// same tradeoff WORD_LIMIT already makes. Also accepts "or" (not just "and") as the closing word —
// "email the landlord, text my sister, or call the plumber" is just as enumerated a list.
const ENUMERATED_LIST_MARKER = /(?:,[^,]*){2,}\b(?:and|or)\b/i

// Two more enumeration shapes found via live testing that ENUMERATED_LIST_MARKER's comma-based
// match doesn't cover: a semicolon-separated list with no "and"/"or" at all ("research the
// company; prepare answers; iron my suit; plan my route"), and a numbered list with no commas and
// no SEQUENCING_MARKERS word like "step" ("1. Call the moving company 2. Buy packing boxes ...").
// Both slipped through the same way the comma-list gap originally did.
const SEMICOLON_LIST_MARKER = /;.*;/
const NUMBERED_LIST_ITEM = /\b\d{1,2}[.)]\s+\S/g

function hasNumberedList(text: string): boolean {
  const matches = text.match(NUMBERED_LIST_ITEM)
  return matches !== null && matches.length >= 2
}

/** Zero-LLM-call gate deciding whether a request is worth spending decomposeObjective's extra call on. */
export function classifyDecompositionCandidate(message: string): DecompositionCandidateClassification {
  const trimmed = message.trim()
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length

  if (SEQUENCING_MARKERS.test(trimmed)) {
    return { isCandidate: true, reason: 'contains a sequencing marker (then/first/next/step ...)' }
  }
  if (ENUMERATED_LIST_MARKER.test(trimmed)) {
    return { isCandidate: true, reason: 'contains a comma-separated enumeration of multiple items' }
  }
  if (SEMICOLON_LIST_MARKER.test(trimmed)) {
    return { isCandidate: true, reason: 'contains a semicolon-separated enumeration of multiple items' }
  }
  if (hasNumberedList(trimmed)) {
    return { isCandidate: true, reason: 'contains a numbered list of multiple items' }
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
  'one step, return a single task. Phrase each `description` starting with the concrete subject or object it ' +
  'acts on (e.g. "the login tests: rerun after the config fix" rather than "rerun the login tests after the ' +
  "config fix\"), so later comparisons against this task's completion/failure beliefs share matching vocabulary. " +
  'Respond with JSON only, no prose: {"tasks":[{"id": string, "description": ' +
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

const REFRAME_SCHEMA = {
  type: 'object',
  properties: {
    description: { type: 'string' },
  },
  required: ['description'],
}

const REFRAME_SYSTEM_PROMPT =
  "Restate the user's message as a single task description, starting with the concrete subject " +
  'or object it acts on (e.g. "the login tests: rerun after the config fix" rather than "rerun the ' +
  'login tests after the config fix"), so later comparisons against this task\'s completion/failure ' +
  'beliefs share matching vocabulary. Preserve the original meaning exactly — do not add, drop, or ' +
  'invent information. Respond with JSON only: {"description": string}.'

/**
 * Reframes a single-task turn's description to lead with its subject — the same phrasing
 * decomposeObjective and buildPlanFromTemplate (plan-builder.ts) already ask their own LLM calls
 * for, applied here for the much more common case where a turn goes through neither: an ad hoc
 * single-task turn whose description otherwise stays the raw verbatim userMessage (see
 * assistant.ts's initialTasks fallback). Without this, only decomposed/planned tasks got
 * subject-first descriptions, so the "Completed: <description>" belief statementsOpposed/
 * isNegation compare against was structured for some tasks and not others. Deliberately not
 * called unconditionally — the caller gates this behind looksLikeCodingFact AND riskLevel !==
 * 'LOW' (the actual precondition for a single task's description to ever reach that belief; see
 * assistant.ts's call site for why looksLikeCodingFact alone isn't a safe gate for a new call).
 * Falls back to null (caller keeps the original message) on any parse failure or LLM error,
 * matching this codebase's other LLM-backed classifiers.
 */
export async function reframeTaskDescriptionWithLLM(
  message: string,
  llmClient: ILLMClient,
  model?: string,
  onUsage?: (usage: TokenUsage) => void,
): Promise<string | null> {
  try {
    const response = await llmClient.callChatStructured(
      [
        { role: 'system', content: REFRAME_SYSTEM_PROMPT },
        { role: 'user', content: message },
      ],
      undefined,
      { model, onUsage, structuredOutput: { schema: REFRAME_SCHEMA } },
    )
    const parsed = JSON.parse(response.content) as { description?: unknown }
    if (typeof parsed.description !== 'string' || !parsed.description.trim()) return null
    return parsed.description.trim()
  } catch {
    return null
  }
}
