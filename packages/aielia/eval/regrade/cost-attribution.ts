/**
 * Per-layer cost attribution (AL2b of plans/adaptive_layer_selection_plan.html).
 *
 * The when-map's arm-level cost deltas ("verification +25%", "decomposition +82%") say *that* a layer
 * costs more, not *why*. This attributes every LLM call in a saved transcript to a purpose by the
 * signature of its system prompt — the fixed per-turn floor (classifier, proposer) or a specific
 * layer's own sub-call — and takes the on-vs-off per-purpose delta, so a cost claim can be split
 * into "the layer's own calls" vs "extra proposer iterations the layer caused" (soft-failure
 * retries, a re-asked answer) vs "the floor moved". Cost claims in the map come from here.
 *
 *   npx tsx eval/regrade/cost-attribution.ts            # write docs/layer_cost_attribution.md
 *   npx tsx eval/regrade/cost-attribution.ts --stdout
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { LAYER_SOURCES } from './layer-value.js'

/** The fixed per-turn floor: every turn pays for these regardless of which layers are on. */
export const FLOOR_PURPOSES = ['classifier', 'proposer'] as const

export type Purpose =
  | 'classifier'
  | 'proposer'
  | 'contradiction_check'
  | 'change_review'
  | 'criterion_coverage'
  | 'failure_match'
  | 'injection_detection'
  | 'supervisor'
  | 'decomposition_reframe'
  | 'plan_drafting'
  | 'goal_graph'
  | 'next_steps'
  | 'unattributed'

/** First matching signature wins. Signatures are the opening words of each call site's system prompt. */
const SIGNATURES: ReadonlyArray<[RegExp, Purpose]> = [
  [/^Classify the user's message/, 'classifier'],
  [/^You are Aielia, a helpful|^You are a helpful assistant with access to tools|^You are working through one item/, 'proposer'],
  [/^You check a personal assistant's beliefs for genuine contradictions/, 'contradiction_check'],
  [/^You check whether a proposed action genuinely conflicts/, 'change_review'],
  [/^You check whether a success criterion is genuinely satisfied/, 'criterion_coverage'],
  [/^You match a set of observed symptoms against a curated library/, 'failure_match'],
  [/^You are a security classifier analyzing untrusted external content/, 'injection_detection'],
  [/^You are a trajectory supervisor/, 'supervisor'],
  [/^Restate the user's message as a single task description|^You are adapting a ".*" plan template/, 'decomposition_reframe'],
  [/^You are drafting a multi-step plan|^You are reviewing a drafted plan/, 'plan_drafting'],
  [/^You match an incoming user message against a list of existing goal threads|^A task is currently executing for a user|^A goal the user was working on/, 'goal_graph'],
]

export function classifyCall(systemPrompt: string): Purpose {
  const s = systemPrompt.trimStart()
  for (const [re, purpose] of SIGNATURES) if (re.test(s)) return purpose
  return 'unattributed'
}

export interface CostBucket {
  calls: number
  tokens: number
  costUsd: number
  latencyMs: number
}

const empty = (): CostBucket => ({ calls: 0, tokens: 0, costUsd: 0, latencyMs: 0 })

interface TranscriptEvent {
  t?: number
  kind: string
  messages?: Array<{ role?: string; content?: unknown }>
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number }
}
export interface AttributableTranscript {
  arm: string
  events?: TranscriptEvent[]
}

const textOf = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p === 'string' ? p : (p as { text?: string })?.text ?? '')).join('') : '')

function systemPromptOf(e: TranscriptEvent): string {
  const m = e.messages ?? []
  return textOf((m.find((x) => x.role === 'system') ?? m[0])?.content)
}

/**
 * Attribute one transcript's LLM calls. Requests pair with the next response in order (calls in a
 * turn are sequential); latency is response time minus request time; tokens and cost are the
 * backend-reported `usage` on the response. A request with no response contributes a call only.
 * Extra proposer calls after the first are also counted in `proposerIterations`.
 */
export function attributeTranscript(t: AttributableTranscript): { byPurpose: Partial<Record<Purpose, CostBucket>>; proposerIterations: number } {
  const byPurpose: Partial<Record<Purpose, CostBucket>> = {}
  let pending: { purpose: Purpose; t: number } | null = null
  let proposerIterations = 0
  const bucket = (p: Purpose) => (byPurpose[p] ??= empty())
  for (const e of t.events ?? []) {
    if (e.kind === 'llm_request') {
      if (pending) bucket(pending.purpose).calls++ // unanswered request
      pending = { purpose: classifyCall(systemPromptOf(e)), t: e.t ?? 0 }
    } else if (e.kind === 'llm_response' && pending) {
      const b = bucket(pending.purpose)
      b.calls++
      b.tokens += (e.usage?.inputTokens ?? 0) + (e.usage?.outputTokens ?? 0)
      b.costUsd += e.usage?.costUsd ?? 0
      b.latencyMs += Math.max(0, (e.t ?? pending.t) - pending.t)
      if (pending.purpose === 'proposer') proposerIterations++
      pending = null
    }
  }
  if (pending) bucket(pending.purpose).calls++
  return { byPurpose, proposerIterations }
}

export interface ArmAttribution {
  arm: string
  runs: number
  /** Mean per run. */
  byPurpose: Partial<Record<Purpose, CostBucket>>
  meanTotal: CostBucket
  meanProposerIterations: number
}

export function attributeArm(arm: string, transcripts: readonly AttributableTranscript[]): ArmAttribution {
  const sum: Partial<Record<Purpose, CostBucket>> = {}
  const total = empty()
  let iterations = 0
  for (const t of transcripts) {
    const a = attributeTranscript(t)
    iterations += a.proposerIterations
    for (const [p, b] of Object.entries(a.byPurpose) as Array<[Purpose, CostBucket]>) {
      const s = (sum[p] ??= empty())
      for (const k of ['calls', 'tokens', 'costUsd', 'latencyMs'] as const) { s[k] += b[k]; total[k] += b[k] }
    }
  }
  const n = transcripts.length || 1
  const mean = (b: CostBucket): CostBucket => ({ calls: b.calls / n, tokens: b.tokens / n, costUsd: b.costUsd / n, latencyMs: b.latencyMs / n })
  return {
    arm,
    runs: transcripts.length,
    byPurpose: Object.fromEntries(Object.entries(sum).map(([p, b]) => [p, mean(b as CostBucket)])) as Partial<Record<Purpose, CostBucket>>,
    meanTotal: mean(total),
    meanProposerIterations: iterations / n,
  }
}

export interface PurposeDelta {
  purpose: Purpose
  on: CostBucket
  off: CostBucket
  delta: CostBucket
  /** Share of the arm-level cost delta this purpose explains (`null` when the arm delta is 0). */
  shareOfCostDelta: number | null
}

export interface CostExplanation {
  runsOn: number
  runsOff: number
  totalDelta: CostBucket
  /** Relative arm-level deltas — the numbers the when-map used to quote. */
  relative: { costUsd: number | null; calls: number | null; latencyMs: number | null }
  purposes: PurposeDelta[]
  /** Delta owed to the layer's own sub-calls (every non-floor, non-proposer purpose). */
  ownCalls: CostBucket
  /** Delta owed to the proposer running more (or fewer) times — loop iterations the layer induced. */
  proposerDelta: CostBucket
  /** Delta owed to the classifier (should be ~0; non-zero means the floor moved). */
  classifierDelta: CostBucket
  /** One sentence naming where the cost went. */
  summary: string
}

/** A classifier-cost share of the arm delta at/above this reads as noise: that call is the same in both arms. */
export const NOISE_SHARE = 0.25

const sub = (a: CostBucket, b: CostBucket): CostBucket => ({ calls: a.calls - b.calls, tokens: a.tokens - b.tokens, costUsd: a.costUsd - b.costUsd, latencyMs: a.latencyMs - b.latencyMs })
const add = (a: CostBucket, b: CostBucket): CostBucket => ({ calls: a.calls + b.calls, tokens: a.tokens + b.tokens, costUsd: a.costUsd + b.costUsd, latencyMs: a.latencyMs + b.latencyMs })
const rel = (d: number, base: number): number | null => (base === 0 ? null : d / base)

/** Explain the on-vs-off cost delta by purpose. Pure. */
export function explainCostDelta(on: ArmAttribution, off: ArmAttribution): CostExplanation {
  const names = [...new Set([...Object.keys(on.byPurpose), ...Object.keys(off.byPurpose)])].sort() as Purpose[]
  const totalDelta = sub(on.meanTotal, off.meanTotal)
  const purposes: PurposeDelta[] = names.map((purpose) => {
    const o = on.byPurpose[purpose] ?? empty()
    const f = off.byPurpose[purpose] ?? empty()
    const delta = sub(o, f)
    return { purpose, on: o, off: f, delta, shareOfCostDelta: totalDelta.costUsd === 0 ? null : delta.costUsd / totalDelta.costUsd }
  })
  let ownCalls = empty()
  for (const p of purposes) if (!(FLOOR_PURPOSES as readonly string[]).includes(p.purpose)) ownCalls = add(ownCalls, p.delta)
  const proposerDelta = purposes.find((p) => p.purpose === 'proposer')?.delta ?? empty()
  const classifierDelta = purposes.find((p) => p.purpose === 'classifier')?.delta ?? empty()
  const pct = (x: number | null) => (x === null ? 'n/a' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}%`)
  const relative = { costUsd: rel(totalDelta.costUsd, off.meanTotal.costUsd), calls: rel(totalDelta.calls, off.meanTotal.calls), latencyMs: rel(totalDelta.latencyMs, off.meanTotal.latencyMs) }
  const share = (b: CostBucket) => (totalDelta.costUsd === 0 ? 'n/a' : `${((b.costUsd / totalDelta.costUsd) * 100).toFixed(0)}%`)
  const noisy = totalDelta.costUsd !== 0 && Math.abs(classifierDelta.costUsd / totalDelta.costUsd) >= NOISE_SHARE
  const noise = noisy ? ` The classifier call is identical in both arms, so that share is run-to-run variation (price/usage drift), not the layer — read the arm-level delta as at most the remainder.` : ''
  const summary =
    `Attributed $/turn ${pct(relative.costUsd)} and LLM calls ${pct(relative.calls)}: the layer's own sub-calls account for ${share(ownCalls)} of the cost delta ` +
    `(${ownCalls.calls >= 0 ? '+' : ''}${ownCalls.calls.toFixed(2)} calls/turn), extra proposer iterations for ${share(proposerDelta)} ` +
    `(${proposerDelta.calls >= 0 ? '+' : ''}${proposerDelta.calls.toFixed(2)} calls/turn), and the classifier floor for ${share(classifierDelta)}.${noise}`
  return { runsOn: on.runs, runsOff: off.runs, totalDelta, relative, purposes, ownCalls, proposerDelta, classifierDelta, summary }
}

// ── Loading and rendering ─────────────────────────────────────────────────────────────────────

export function loadArmTranscripts(auditDir: string, feature: string, arm: string): AttributableTranscript[] | undefined {
  const dir = join(auditDir, feature, 'transcripts')
  if (!existsSync(dir)) return undefined
  return readdirSync(dir)
    .filter((n) => n.endsWith('.json') && n.startsWith(`${arm}__`))
    .sort()
    .map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')) as AttributableTranscript)
}

export interface FeatureCost {
  feature: string
  mechanism: string
  onArm: string
  offArm: string
  explanation: CostExplanation
}

export function buildCostAttribution(auditDir: string): FeatureCost[] {
  const out: FeatureCost[] = []
  for (const s of LAYER_SOURCES) {
    const on = loadArmTranscripts(auditDir, s.feature, s.onArm)
    const off = loadArmTranscripts(auditDir, s.feature, s.offArm)
    if (!on?.length || !off?.length) continue
    out.push({ feature: s.feature, mechanism: s.mechanism, onArm: s.onArm, offArm: s.offArm, explanation: explainCostDelta(attributeArm(s.onArm, on), attributeArm(s.offArm, off)) })
  }
  return out
}

export function renderCostMarkdown(features: readonly FeatureCost[]): string {
  const f2 = (x: number, d = 2) => (x >= 0 ? '+' : '') + x.toFixed(d)
  const lines = [
    '# Layer cost attribution (AL2b)',
    '',
    'Generated by `packages/aielia/eval/regrade/cost-attribution.ts` from the saved transcripts. Every LLM call is attributed to a purpose by its system-prompt signature; the delta is layer-on minus layer-off, mean per run. Cost claims about a layer should quote this file, not an arm-level total.',
    '',
  ]
  for (const f of features) {
    const e = f.explanation
    lines.push(`## ${f.feature} — \`${f.mechanism}\` (${f.onArm} vs ${f.offArm}; ${e.runsOn} vs ${e.runsOff} runs)`, '', e.summary, '')
    lines.push('| purpose | calls on | calls off | Δ calls | Δ tokens | Δ $ | Δ latency ms | share of $ Δ |', '|---|---|---|---|---|---|---|---|')
    for (const p of e.purposes) {
      lines.push(`| ${p.purpose} | ${p.on.calls.toFixed(2)} | ${p.off.calls.toFixed(2)} | ${f2(p.delta.calls)} | ${f2(p.delta.tokens)} | ${f2(p.delta.costUsd, 4)} | ${f2(p.delta.latencyMs)} | ${p.shareOfCostDelta === null ? 'n/a' : (p.shareOfCostDelta * 100).toFixed(0) + '%'} |`)
    }
    lines.push('')
  }
  return lines.join('\n') + '\n'
}

const HERE = dirname(fileURLToPath(import.meta.url))
const EVAL = dirname(HERE)
const REPO = resolve(EVAL, '..', '..', '..')

function main(): void {
  const md = renderCostMarkdown(buildCostAttribution(join(EVAL, 'reports', 'audit')))
  if (process.argv.includes('--stdout')) console.log(md)
  else writeFileSync(join(REPO, 'docs', 'layer_cost_attribution.md'), md)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
