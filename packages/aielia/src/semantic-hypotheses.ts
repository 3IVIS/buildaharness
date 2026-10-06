import type { ILLMClient, TokenUsage } from '@buildaharness/runtime'
import type { SemanticHypothesisProposal } from '@buildaharness/harness'
import { parseModelJson } from './model-json.js'

/** Marks a proposer-facing note that carries competing explanations (see AgentLoop.createHarnessProposer). */
export const HYPOTHESIS_NOTE_PREFIX = '[hypotheses] '

const MAX_HYPOTHESES = 4

const PROPOSE_SCHEMA = {
  type: 'object',
  properties: {
    hypotheses: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          explanation: { type: 'string' },
          predicted_observations: { type: 'array', items: { type: 'string' } },
          separating_check: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: ['explanation', 'predicted_observations'],
      },
    },
  },
  required: ['hypotheses'],
}

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    contradicted: {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string' } }, required: ['id'] },
    },
  },
  required: ['contradicted'],
}

const PROPOSE_PROMPT =
  'You propose competing explanations for an underdetermined request. You are given JSON with "request" (what the ' +
  'user asked), "observations" (things already gathered, possibly none) and "beliefs" (what is already known). ' +
  'Respond with JSON only: {"hypotheses": [{"explanation": string, "predicted_observations": string[], ' +
  '"separating_check": string, "confidence": number}]}. If the request has one obvious answer or cause, or does not ' +
  'ask why something happened or which of several things is true, respond {"hypotheses": []}. Otherwise give 2 to 4 ' +
  'genuinely different explanations — different causes, not rewordings of one. "explanation" is one sentence. ' +
  '"predicted_observations" is what you would expect to see if that explanation were true. "separating_check" is the ' +
  'one check or observation that would tell it apart from the others. "confidence" is between 0 and 1, the values ' +
  'across the set should sum to about 1, and each must reflect only what the request and observations support — ' +
  'never favour an explanation the evidence does not favour. The message may be in any language.'

const JUDGE_PROMPT =
  'You decide which explanations a set of new observations rules out. You are given JSON with "hypotheses" ' +
  '(each {"id", "explanation", "predicted_observations"}) and "observations" (just gathered). Respond with JSON only: ' +
  '{"contradicted": [{"id": string, "reason": string}]}. An explanation is contradicted only when an observation ' +
  'clearly rules it out — it states the opposite of something the explanation requires, or shows absent something the ' +
  'explanation predicts. An observation that does not mention an explanation, or is compatible with it, does not ' +
  'contradict it. When unsure, do not list it. "reason" is one short phrase. Empty array if nothing is ruled out.'

/**
 * `AUDIT_SEMANTIC_HYPOTHESES` gate. Default **OFF**: hypotheses stay the template seeds the harness generates and
 * nothing is shown to the model. A truthy value (`1` / `true` / `on` / `yes` / `enabled`) lets the harness ask, once
 * per turn, for competing explanations of a request the classifier judged underdetermined, judge them against the
 * evidence each execution gathers, and put them in front of the proposer. It changes what the assistant says, so it
 * ships off until a benchmark shows it helps. Read at one site: harness-bridge.ts.
 */
export function semanticHypothesesEnabled(env?: Record<string, string | undefined>): boolean {
  const source = env ?? (typeof process !== 'undefined' ? process.env : {})
  const raw = String(source.AUDIT_SEMANTIC_HYPOTHESES ?? '').trim().toLowerCase()
  return ['1', 'true', 'on', 'yes', 'enabled'].includes(raw)
}

const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : [])

/** One bounded LLM call: 2-4 competing explanations, or none. Fails open — any error or unusable answer is null. */
export async function proposeCompetingExplanations(
  input: { request: string; observations: string[]; beliefs: string[] },
  llmClient: ILLMClient,
  model?: string,
  onUsage?: (usage: TokenUsage) => void,
): Promise<SemanticHypothesisProposal[] | null> {
  try {
    const response = await llmClient.callChatStructured(
      [
        { role: 'system', content: PROPOSE_PROMPT },
        { role: 'user', content: JSON.stringify({ request: input.request, observations: input.observations.slice(-12), beliefs: input.beliefs.slice(-12) }) },
      ],
      undefined,
      { model, onUsage, structuredOutput: { schema: PROPOSE_SCHEMA } },
    )
    const parsed = parseModelJson(response.content) as { hypotheses?: unknown }
    if (!Array.isArray(parsed.hypotheses)) return null
    const out: SemanticHypothesisProposal[] = []
    for (const h of parsed.hypotheses as Array<Record<string, unknown>>) {
      if (typeof h?.explanation !== 'string' || !h.explanation.trim()) continue
      out.push({
        explanation: h.explanation.trim(),
        predicted_observations: asStrings(h.predicted_observations),
        ...(typeof h.separating_check === 'string' && h.separating_check.trim() ? { separating_check: h.separating_check.trim() } : {}),
        ...(typeof h.confidence === 'number' && Number.isFinite(h.confidence) ? { confidence: Math.min(1, Math.max(0, h.confidence)) } : {}),
      })
      if (out.length === MAX_HYPOTHESES) break
    }
    // One explanation is not a competition.
    return out.length >= 2 ? out : null
  } catch {
    return null
  }
}

/** One bounded LLM call: which of the explanations do these observations rule out? Fails open — null. */
export async function judgeHypothesesAgainstEvidence(
  input: { hypotheses: Array<{ id: string; explanation: string; predicted_observations: string[] }>; observations: string[] },
  llmClient: ILLMClient,
  model?: string,
  onUsage?: (usage: TokenUsage) => void,
): Promise<{ contradicted: Array<{ id: string; reason?: string }> } | null> {
  if (input.hypotheses.length === 0 || input.observations.length === 0) return null
  try {
    const response = await llmClient.callChatStructured(
      [
        { role: 'system', content: JUDGE_PROMPT },
        { role: 'user', content: JSON.stringify({ hypotheses: input.hypotheses, observations: input.observations.slice(-12) }) },
      ],
      undefined,
      { model, onUsage, structuredOutput: { schema: JUDGE_SCHEMA } },
    )
    const parsed = parseModelJson(response.content) as { contradicted?: unknown }
    if (!Array.isArray(parsed.contradicted)) return null
    const known = new Set(input.hypotheses.map((h) => h.id))
    const contradicted: Array<{ id: string; reason?: string }> = []
    for (const c of parsed.contradicted as Array<Record<string, unknown>>) {
      if (typeof c?.id !== 'string' || !known.has(c.id)) continue
      contradicted.push({ id: c.id, ...(typeof c.reason === 'string' && c.reason.trim() ? { reason: c.reason.trim() } : {}) })
    }
    return { contradicted }
  } catch {
    return null
  }
}

/** The proposer-facing note: the competing explanations and what would tell them apart. */
export function renderHypothesisNote(hypotheses: Array<{ explanation: string; predicted_observations: string[]; separating_check?: string }>): string {
  const lines = hypotheses.map((h) => {
    const bits = [h.predicted_observations.length ? `you would expect: ${h.predicted_observations.join('; ')}` : '', h.separating_check ? `to tell it apart: ${h.separating_check}` : ''].filter(Boolean)
    return `- ${h.explanation}${bits.length ? ` (${bits.join(' — ')})` : ''}`
  })
  return `${HYPOTHESIS_NOTE_PREFIX}${lines.join('\n')}`
}

/** The user turn the proposer sees for a hypothesis note (the note text without its prefix). */
export function hypothesisContextMessage(noteBody: string): string {
  return (
    '[the request can be explained several ways and nothing you have read separates them — do not assert one as the ' +
    'answer unless the evidence you gather rules the others out; lay out the competing explanations and what would tell ' +
    `them apart]\n${noteBody}`
  )
}
