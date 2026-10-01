import type { ILLMClient, TokenUsage } from '@buildaharness/runtime'
import { parseModelJson } from './model-json.js'
import { shortenForCheck } from './task-completion-check.js'

export interface ConstraintViolation {
  constraint: string
  reason?: string
}

const CONSTRAINT_SCHEMA = {
  type: 'object',
  properties: {
    violations: {
      type: 'array',
      items: {
        type: 'object',
        properties: { constraint: { type: 'string' }, reason: { type: 'string' } },
        required: ['constraint'],
      },
    },
  },
  required: ['violations'],
}

const SYSTEM_PROMPT =
  "You judge whether an assistant's reply violates constraints the user set. You are given JSON with " +
  '"constraints" (things the user told the assistant to do or avoid) and "reply" (what the assistant wrote). ' +
  'Respond with JSON only: {"violations": [{"constraint": string, "reason": string}]}. List a constraint only ' +
  'when the reply clearly does what it forbids, or plainly ignores what it requires. A reply that mentions, ' +
  'acknowledges, repeats or promises to follow a constraint is NOT a violation ("I will not use tabs" obeys ' +
  '"do not use tabs"), and neither is a reply that talks about the constrained subject without doing the forbidden ' +
  'thing. A stylistic preference is not violated by a reply that reasonably meets it. "constraint" is copied ' +
  'exactly from the input; "reason" is one short sentence. An empty array when nothing is clearly violated. A ' +
  'long reply may be shortened in the middle (marked "[... omitted ...]"): judge on what you can see.'

/**
 * `AUDIT_SEMANTIC_CONSTRAINT_CHECK` gate. Default **ON**: the harness's lexical caller-constraint check throws on any
 * reply that names the constraint's subject — including one that obeys it — so this replaces it rather than adding
 * to it, and only runs when the caller has set a constraint (the lexical check's own precondition). Set to a falsy
 * value (`0` / `false` / `off` / `no` / `disabled`) to keep the lexical check. Read at exactly one site: harness-bridge.ts.
 */
export function semanticConstraintCheckEnabled(env?: Record<string, string | undefined>): boolean {
  const source = env ?? (typeof process !== 'undefined' ? process.env : {})
  const raw = String(source.AUDIT_SEMANTIC_CONSTRAINT_CHECK ?? '').trim().toLowerCase()
  if (raw === '') return true
  return !['0', 'false', 'off', 'no', 'disabled'].includes(raw)
}

/**
 * What to append to a reply the judge still found breaking a constraint after the one revision (the harness hands the answer
 * back with the violation instead of failing the turn). Empty when nothing is unresolved.
 */
export function renderUnresolvedConstraintNote(violations: ReadonlyArray<ConstraintViolation> | undefined): string {
  if (!violations || violations.length === 0) return ''
  const lines = violations.map((v) => `- ${v.constraint}${v.reason ? ` (${v.reason})` : ''}`)
  return `\n\n---\nI tried to fix this once, but the answer above may not fully meet ${violations.length === 1 ? 'a constraint' : 'constraints'} you set:\n${lines.join('\n')}`
}

/** Most standing constraints kept per session; the oldest drop first. */
export const MAX_STANDING_CONSTRAINTS = 8

/**
 * Standing constraints plus the ones stated now: trimmed, de-duplicated (case-insensitive), the newest last, capped at
 * MAX_STANDING_CONSTRAINTS (oldest dropped). A constraint restated moves to the end rather than appearing twice.
 */
export function mergeStandingConstraints(existing: readonly string[], incoming: readonly string[]): string[] {
  const merged: string[] = []
  for (const raw of [...existing, ...incoming]) {
    const text = typeof raw === 'string' ? raw.trim() : ''
    if (!text) continue
    const at = merged.findIndex((c) => c.toLowerCase() === text.toLowerCase())
    if (at >= 0) merged.splice(at, 1)
    merged.push(text)
  }
  return merged.slice(-MAX_STANDING_CONSTRAINTS)
}

/**
 * One bounded LLM call: does this reply break any of these constraints? Fails open — an error, an empty reply or an
 * unparseable answer is "no violations", so a broken check can never fail a turn that would have passed. Only
 * constraints the caller actually set are reported (a constraint the model invented is dropped).
 */
export async function checkConstraints(
  input: { constraints: string[]; reply: string },
  llmClient: ILLMClient,
  model?: string,
  onUsage?: (usage: TokenUsage) => void,
): Promise<{ violated: ConstraintViolation[] }> {
  if (input.constraints.length === 0 || !input.reply.trim()) return { violated: [] }
  try {
    const response = await llmClient.callChatStructured(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify({ constraints: input.constraints, reply: shortenForCheck(input.reply) }) },
      ],
      undefined,
      { model, onUsage, structuredOutput: { schema: CONSTRAINT_SCHEMA } },
    )
    const parsed = parseModelJson(response.content) as { violations?: unknown }
    if (!Array.isArray(parsed.violations)) return { violated: [] }
    const known = new Set(input.constraints)
    const violated: ConstraintViolation[] = []
    for (const v of parsed.violations as Array<{ constraint?: unknown; reason?: unknown }>) {
      if (typeof v?.constraint !== 'string' || !known.has(v.constraint)) continue
      violated.push({ constraint: v.constraint, reason: typeof v.reason === 'string' ? v.reason : undefined })
    }
    return { violated }
  } catch {
    return { violated: [] }
  }
}
