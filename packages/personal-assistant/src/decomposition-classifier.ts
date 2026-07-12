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
// The "first[,:]" branch above requires trailing punctuation — found via live testing: "First book
// the flight to Denver and reserve a rental car for the same dates" uses "First" as a plain
// sentence-initial adverb with no comma/colon after it, no "then", and no comma-enumeration, so it
// fell through every signal and was under-reported as a single-step request. A sentence-initial
// "First" (no comma/colon immediately after, so it doesn't double-match the branch above) followed
// somewhere later by "and" is the same two-step shape without the punctuation.
const SEQUENCING_MARKERS = /\b(then|after that|and then|next,|step \d|first[,:]|finally,)\b|^first\b(?!\s*[,:])(?=.*\band\b)/i
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
// A 3-item list WITHOUT the Oxford comma ("call the bank, email the landlord and pick up dry
// cleaning") has only 1 comma before the closing and/or, so the 2-comma alternative above doesn't
// catch it. Found via live testing: this exact phrasing silently bulk-created 3 reminders with
// zero confirmation (risk-classifier.ts's bulk-reminder gate depends on this same function), and
// separately under-reported an ordinary 3-subtask request as "one eligible task" in /layers. A
// single comma followed by and/or is ambiguous between this shape and an ordinary compound
// sentence ("I called the bank, and it was closed.") — the distinguishing signal used here is
// that a compound sentence's second clause almost always reintroduces its own subject right after
// and/or (I/we/you/he/she/it/they), while a list item continues straight into a verb/noun phrase
// instead. A false positive here (an ordinary 2-item compound imperative like "Buy milk, and lock
// the door.") just costs one extra confirmation, the same tradeoff this file already accepts
// elsewhere.
// The subject-reintroduction exclusion above only covered PRONOUNS -- found via live testing:
// "Remind me to call the bank, and my accountant's office is closed on Fridays anyway" reintroduces
// a new NOUN subject ("my accountant's office") rather than a pronoun, so it wasn't excluded and
// this single reminder plus an unrelated aside wrongly tripped the bulk-reminder confirmation gate.
// A possessive/article/demonstrative/bare-quantifier right after and/or (the same
// NOUN_CONTEXT_DETERMINERS shape risk-classifier.ts's noun-vs-verb patterns already use) is just as
// much a new subject being introduced as a bare pronoun is.
// Still doesn't cover a PROPER noun reintroducing the subject — found via live testing: "Remind me
// to call the bank, and Sarah will handle the rest of the emails." reintroduces the subject via a
// name ("Sarah"), not a pronoun or determiner, so it still matched and wrongly tripped the same
// gate. A capitalized word right after and/or, mid-message (so the capital letter is meaningful,
// not just sentence-initial capitalization), is checked separately below in isEnumeratedListShape
// rather than folded into this case-insensitive regex — the "i" flag needed for the pronoun/
// determiner alternation would otherwise make an upper-vs-lowercase check meaningless.
// h9: the subject-reintroduction exclusion only covered exact pronoun/determiner tokens — an
// indefinite pronoun like "someone"/"everybody"/"anybody" isn't one of those (and "some" as a
// substring doesn't match due to the \b boundary), so it wasn't excluded either — found via live
// testing: "Remind me to call the bank, and someone will follow up separately about the wire
// transfer paperwork." (a single reminder plus an unrelated aside) wrongly tripped the
// bulk-reminder confirmation gate.
// batch 10 re-probe (conv166/h10): existential "there" ("there's a package coming") isn't a
// pronoun/determiner/indefinite-pronoun either, and wasn't in the exclusion list — found via live
// testing: "Remind me to call the bank, and there's a package coming today too." (a single
// reminder plus an unrelated aside) wrongly tripped the bulk-reminder confirmation gate and got
// needlessly declined fails-closed, blocking a genuine single-reminder request outright.
const ONE_COMMA_LIST_MARKER =
  /,[^,]*\b(?:and|or)\s+(?!(?:i|we|you|he|she|it|they|there|my|his|her|their|our|your|the|this|that|an?|no|any|some|every|each|someone|somebody|anybody|anyone|everybody|everyone|nobody)\b)(\S+)/i

const TWO_COMMA_LIST_MARKER = /(?:,[^,]*){2,}\b(?:and|or)\b/i

function isEnumeratedListShape(trimmed: string): boolean {
  if (TWO_COMMA_LIST_MARKER.test(trimmed)) return true
  const match = ONE_COMMA_LIST_MARKER.exec(trimmed)
  if (!match) return false
  return !/^[A-Z]/.test(match[1])
}

// Two more enumeration shapes found via live testing that ENUMERATED_LIST_MARKER's comma-based
// match doesn't cover: a semicolon-separated list with no "and"/"or" at all ("research the
// company; prepare answers; iron my suit; plan my route"), and a numbered list with no commas and
// no SEQUENCING_MARKERS word like "step" ("1. Call the moving company 2. Buy packing boxes ...").
// Both slipped through the same way the comma-list gap originally did.
//
// 2+ semicolons (3+ items) is a strong signal on its own. A genuine 2-subtask request needs only
// 1 semicolon ("Look up the weather...; also find me a good vegetarian restaurant...") and was
// still falling through every signal (no sequencing word, no comma-enumeration, short enough to
// dodge WORD_LIMIT) — but a bare single-semicolon check is too loose: it also matches an ordinary
// compound sentence that just happens to use a semicolon grammatically ("The meeting is at 3;
// let me know if that works.", covered by this file's own test), which is one thought, not two
// subtasks. Requiring an explicit second-task cue word (also/additionally/plus) right after a
// lone semicolon distinguishes the two: it catches convJ's shape without flagging every
// semicolon-joined compound sentence.
const SEMICOLON_LIST_MARKER = /;.*;|;\s*(?:also|additionally|plus)\b/i
const NUMBERED_LIST_ITEM = /\b\d{1,2}[.)]\s+\S/g

function hasNumberedList(text: string): boolean {
  const matches = text.match(NUMBERED_LIST_ITEM)
  return matches !== null && matches.length >= 2
}

// An unrelated fact/aside followed by exactly one "remind me" ("I'm vegan, and remind me to buy
// oat milk on the way home tonight") isn't a bulk-reminder list — it's one reminder request
// continuing after a comma+and, and ONE_COMMA_LIST_MARKER's subject-reintroduction exclusion
// doesn't cover "remind" (it can't, safely: a genuine bulk request phrased as "Remind me to call
// the bank, and remind me to email the landlord" also has "remind" right after "and", and that one
// MUST still gate). The distinguishing signal is that a genuine bulk request repeats "remind" for
// each item, while a single fact+reminder combo has exactly one "remind" in the whole message —
// found via live testing: this ordinary everyday phrasing wrongly forced an unnecessary
// bulk-reminder confirmation.
const FACT_THEN_SINGLE_REMINDER = /,\s*(?:and|or)\s+remind me\b/i

function isFactThenSingleReminder(trimmed: string): boolean {
  const remindMatches = trimmed.match(/\bremind\b/gi)
  return remindMatches !== null && remindMatches.length === 1 && FACT_THEN_SINGLE_REMINDER.test(trimmed)
}

/**
 * True if `message` looks like an enumeration of multiple distinct items — the strong signals
 * above (sequencing markers, comma/semicolon/numbered lists), deliberately WITHOUT
 * classifyDecompositionCandidate's word-count fallback: a single long reminder isn't multiple
 * reminders just because it's wordy, so that weaker signal would false-positive here in a way it
 * doesn't matter for the (cheap, one-extra-LLM-call) decomposition-candidate use case. Used by
 * risk-classifier.ts to gate bulk reminder creation on confirmation instead of letting the model
 * silently create several reminders in one turn.
 */
export function looksLikeEnumeratedItems(message: string): boolean {
  const trimmed = message.trim()
  if (isFactThenSingleReminder(trimmed)) return false
  return SEQUENCING_MARKERS.test(trimmed) || isEnumeratedListShape(trimmed) || SEMICOLON_LIST_MARKER.test(trimmed) || hasNumberedList(trimmed)
}

/** Zero-LLM-call gate deciding whether a request is worth spending decomposeObjective's extra call on. */
export function classifyDecompositionCandidate(message: string): DecompositionCandidateClassification {
  const trimmed = message.trim()
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length

  if (SEQUENCING_MARKERS.test(trimmed)) {
    return { isCandidate: true, reason: 'contains a sequencing marker (then/first/next/step ...)' }
  }
  if (isEnumeratedListShape(trimmed)) {
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
