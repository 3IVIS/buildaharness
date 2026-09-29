import type { ILLMClient, TokenUsage } from '@buildaharness/runtime'
import type { AssistantSource } from './assistant-source.js'
import { parseModelJson } from './model-json.js'

export type SourceReliability = 'HIGH' | 'MEDIUM' | 'LOW'

export interface SourceAssessment {
  path: string
  reliability: SourceReliability
  reason: string
}

export interface SourceWeighing {
  assessments: SourceAssessment[]
  /**
   * `false` only when the sources materially disagree or differ in reliability AND the reply leans on a
   * lower-reliability one, or presents them as equal without saying so. Everything else is `true`.
   */
  weighed: boolean
  /** One or two sentences telling the assistant how to weigh the sources — used only when `weighed` is false. */
  note?: string
}

/** Prefix of the evidence ids this module writes, so a reader can tell an assessment from a tool observation. */
export const SOURCE_RELIABILITY_EVIDENCE_PREFIX = 'source-reliability:'

const WEIGHING_SCHEMA = {
  type: 'object',
  properties: {
    assessments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          reliability: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
          reason: { type: 'string' },
        },
        required: ['path', 'reliability', 'reason'],
      },
    },
    weighed: { type: 'boolean' },
    note: { type: 'string' },
  },
  required: ['assessments', 'weighed'],
}

const SYSTEM_PROMPT =
  'You weigh the reliability of the sources an assistant read before answering. You are given JSON with ' +
  '"question" (what the user asked), "sources" (each with "path", the "tool" that read it and an "excerpt" of ' +
  'what it returned) and "reply" (the assistant\'s answer). Respond with JSON only: ' +
  '{"assessments": [{"path": string, "reliability": "HIGH"|"MEDIUM"|"LOW", "reason": string}], "weighed": boolean, "note": string}. ' +
  'Judge each source by its provenance for THIS question — where it lives (its path or URL), what produced it, ' +
  'and whether it marks itself as archived, unverified, secondhand, dated or user-generated — not by whether ' +
  'you agree with its content. HIGH: a primary, authoritative or live source for the question (the running ' +
  'configuration, official documentation). LOW: archived, unverified, outdated, secondhand or anonymous. ' +
  'MEDIUM: anything else, and the default when unsure. "reason" is one short phrase. "weighed" is true when the ' +
  'reply handles the sources sensibly: the sources agree, or their differences do not matter to the question, ' +
  'or the reply prefers the more reliable source or tells the user the sources disagree. "weighed" is false ' +
  'only when the sources materially disagree or differ in reliability AND the reply relies on a lower-reliability ' +
  'source, or treats them as equal without saying they conflict. "note" is one or two sentences telling the ' +
  'assistant how to weigh these sources in a corrected answer; leave it empty when "weighed" is true.'

/**
 * `AUDIT_SEMANTIC_SOURCE_RELIABILITY` gate. Default **OFF**: a turn's sources are never assessed and the
 * reply is never revised, exactly as before. A truthy value (`1` / `true` / `on` / `yes` / `enabled`)
 * turns on one bounded LLM call per multi-source turn, and one revision of an answer the call judged not to
 * have weighed its sources. It changes what the assistant says, so it ships off until a benchmark shows it
 * helps. Read at one site: `AgentLoop.createHarnessProposer`.
 */
export function sourceReliabilityEnabled(env?: Record<string, string | undefined>): boolean {
  const source = env ?? (typeof process !== 'undefined' ? process.env : {})
  const raw = String(source.AUDIT_SEMANTIC_SOURCE_RELIABILITY ?? '').trim().toLowerCase()
  return ['1', 'true', 'on', 'yes', 'enabled'].includes(raw)
}

const WEIGHABLE_TOOLS = new Set(['read_file', 'fetch_url', 'web_search'])

/** The distinct read sources a turn used (a directory listing is not a source of facts). Deduplicated by tool + path. */
export function distinctSources(sources: AssistantSource[]): AssistantSource[] {
  const seen = new Set<string>()
  const out: AssistantSource[] = []
  for (const s of sources) {
    if (!WEIGHABLE_TOOLS.has(s.tool)) continue
    const key = `${s.tool}\u0000${s.path}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}

const RELIABILITIES: ReadonlySet<string> = new Set(['HIGH', 'MEDIUM', 'LOW'])

/**
 * One bounded LLM call over a turn that read two or more distinct sources. Fails open: fewer than two
 * sources, no reply, an error or an unparseable response all return null, so a broken check can never
 * change a reply that would have gone out today.
 */
export async function assessSourceReliability(
  input: { question: string; sources: AssistantSource[]; reply: string },
  llmClient: ILLMClient,
  model?: string,
  onUsage?: (usage: TokenUsage) => void,
): Promise<SourceWeighing | null> {
  const distinct = distinctSources(input.sources)
  if (distinct.length < 2 || !input.reply.trim()) return null
  try {
    const response = await llmClient.callChatStructured(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            question: input.question,
            sources: distinct.map((s) => ({ path: s.path, tool: s.tool, excerpt: s.excerpt ?? '' })),
            reply: input.reply,
          }),
        },
      ],
      undefined,
      { model, onUsage, structuredOutput: { schema: WEIGHING_SCHEMA } },
    )
    const parsed = parseModelJson(response.content) as { assessments?: unknown; weighed?: unknown; note?: unknown }
    const known = new Set(distinct.map((s) => s.path))
    const assessments: SourceAssessment[] = []
    if (Array.isArray(parsed.assessments)) {
      for (const a of parsed.assessments as Array<Record<string, unknown>>) {
        if (typeof a?.path !== 'string' || !known.has(a.path)) continue
        if (typeof a.reliability !== 'string' || !RELIABILITIES.has(a.reliability)) continue
        assessments.push({ path: a.path, reliability: a.reliability as SourceReliability, reason: typeof a.reason === 'string' ? a.reason : '' })
      }
    }
    const note = typeof parsed.note === 'string' ? parsed.note.trim() : ''
    // `weighed: false` with nothing to tell the assistant is not actionable — treat it as weighed.
    return { assessments, weighed: parsed.weighed === false && note ? false : true, ...(note ? { note } : {}) }
  } catch {
    return null
  }
}

/** The minimal evidence-store surface this module writes to — both the harness's and the turn-local store satisfy it. */
export interface EvidenceSink {
  addObservation(evidence: { id: string; obs: string; reliability: SourceReliability; source: string; evidence_type: 'OBSERVATION'; freshness: string }): void
}

/**
 * Records each assessment as an observation carrying the assessed reliability. Written straight to the
 * store's `observations` — deliberately NOT through updateWorldModel: a LOW belief weighs 0 in
 * `belief_health.support`, which could push a run into the resolver's Tier 2 DENY for a source the
 * assistant merely judged less reliable.
 */
export function recordSourceAssessments(store: EvidenceSink, assessments: SourceAssessment[], now = new Date().toISOString()): void {
  for (const a of assessments) {
    store.addObservation({
      id: `${SOURCE_RELIABILITY_EVIDENCE_PREFIX}${a.path}`,
      obs: a.reason ? `${a.path} — ${a.reason}` : a.path,
      reliability: a.reliability,
      source: a.path,
      evidence_type: 'OBSERVATION',
      freshness: now,
    })
  }
}

/** The user turn that asks the assistant to answer again with the sources weighed. */
export function renderSourceNote(weighing: SourceWeighing): string {
  const lines = weighing.assessments.map((a) => `- ${a.path}: ${a.reliability.toLowerCase()} reliability${a.reason ? ` (${a.reason})` : ''}`)
  return (
    '[a source check found your answer may not weigh the sources you read — answer again, preferring the more reliable ' +
    'source and saying plainly where the sources disagree]\n' +
    (lines.length > 0 ? `${lines.join('\n')}\n` : '') +
    (weighing.note ? weighing.note : '')
  ).trimEnd()
}

/**
 * The "Why?" lines for the sources a turn judged less reliable — one per LOW assessment recorded in the
 * claim's evidence. Empty when the check did not run or nothing was judged LOW, so a quiet turn stays quiet.
 */
export function lowerConfidenceSourceLines(claim: { evidence: Array<{ id: string; obs: string; reliability: SourceReliability }> }): string[] {
  return claim.evidence
    .filter((e) => e.id.startsWith(SOURCE_RELIABILITY_EVIDENCE_PREFIX) && e.reliability === 'LOW')
    .map((e) => `Less reliable source: ${e.obs}`)
}
