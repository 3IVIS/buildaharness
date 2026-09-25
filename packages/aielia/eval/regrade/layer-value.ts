/**
 * The when-map (AL2a of plans/adaptive_layer_selection_plan.html).
 *
 * From every (re-graded) audit/probe feature's saved transcripts, compute per layer × regime the
 * paired on-vs-off delta on the layer's *target metric* and on task success, with CI and cost
 * delta, plus the adequacy columns (engagement, headroom, distinct tasks, minimum detectable
 * effect). Every layer ends with an evidence state *per regime* — never a global verdict:
 *
 *   HELPS-IN-REGIME · NULL-IN-TESTED-REGIME · INCONCLUSIVE-UNDERPOWERED · UNTESTED
 *
 * HELPS / NULL require an AL1f adequacy certificate for the layer (`eval/regrade/certificates.json`,
 * `{ [mechanism]: ProbeCertificate }`). Without one a layer's state is at best UNTESTED /
 * INCONCLUSIVE-UNDERPOWERED, so this generator is idempotent and safe to re-run when certificates
 * land (AL1f) or rules change (AL11c). Output is deterministic (no timestamp, sorted keys).
 *
 *   npx tsx eval/regrade/layer-value.ts            # write docs/layer_value_map.{md,json}
 *   npx tsx eval/regrade/layer-value.ts --stdout   # print the markdown, write nothing
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { TaskSpec } from '../corpus/schema.js'
import { MECHANISM_IDS, type MechanismId } from '../corpus/mechanisms.js'
import { minimumDetectableEffect, type ProbeCertificate } from './engagement-probe.js'

export type EvidenceState = 'HELPS-IN-REGIME' | 'NULL-IN-TESTED-REGIME' | 'INCONCLUSIVE-UNDERPOWERED' | 'UNTESTED'

/** Below this engagement (or control headroom) a test says nothing about the layer (matches AL2b's audit rule). */
export const STATE_MIN_ENGAGEMENT = 0.3
export const STATE_MIN_HEADROOM = 0.1
/** A regime needs this many paired runs to be reported at all. */
export const MIN_PAIRS = 3
/** Default smallest success-rate effect that justifies a layer's cost (AL1b's `--justifying-effect`). */
export const JUSTIFYING_EFFECT = 0.1
const Z95 = 1.96

// ── Runs ──────────────────────────────────────────────────────────────────────────────────────

export interface LayerRun {
  feature: string
  taskId: string
  arm: string
  seed: number | string
  category: string
  riskLevel: string
  turnShape: 'single' | 'multi'
  success: boolean
  hallucination: boolean | null
  unauthorizedEffect: boolean | null
  recovered: boolean | null
  invalid: boolean
  firedLayers: readonly string[]
  llmCalls: number
  costUsd: number
  latencyMs: number
}

interface TranscriptFile {
  task: string
  arm: string
  seed: number | string
  events?: Array<{ kind: string; detail?: { kind?: string; layer?: string; fired?: boolean; riskLevel?: string } }>
  grade?: { success?: boolean; invalid?: boolean; verdict?: string; hallucination?: boolean | null; unauthorizedEffect?: boolean | null; recovered?: boolean | null }
  metrics?: { costUsd?: number; latencyMs?: number }
}

const boolOrNull = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)

/** Joins the transcript to the classifier's `riskLevel` (first `risk_classified` event) and turn shape. */
export function runFromTranscript(feature: string, t: TranscriptFile, tasks: ReadonlyMap<string, TaskSpec>): LayerRun {
  const events = t.events ?? []
  const fired = new Set<string>()
  let riskLevel = 'UNKNOWN'
  let seenRisk = false
  let multi = false
  for (const e of events) {
    if (e.kind !== 'trace') continue
    const d = e.detail
    if (d?.kind === 'layer_activity' && d.fired && d.layer) fired.add(d.layer)
    if (d?.kind === 'risk_classified' && !seenRisk && d.riskLevel) { riskLevel = d.riskLevel; seenRisk = true }
    if (d?.kind === 'turn_boundary') multi = true
  }
  return {
    feature,
    taskId: t.task,
    arm: t.arm,
    seed: t.seed,
    category: tasks.get(t.task)?.category ?? 'unknown',
    riskLevel,
    turnShape: multi ? 'multi' : 'single',
    success: t.grade?.success === true,
    hallucination: boolOrNull(t.grade?.hallucination),
    unauthorizedEffect: boolOrNull(t.grade?.unauthorizedEffect),
    recovered: boolOrNull(t.grade?.recovered),
    invalid: t.grade?.invalid === true || t.grade?.verdict === 'INVALID_TASK',
    firedLayers: [...fired].sort(),
    llmCalls: events.filter((e) => e.kind === 'llm_request').length,
    costUsd: t.metrics?.costUsd ?? 0,
    latencyMs: t.metrics?.latencyMs ?? 0,
  }
}

// ── Layer sources and target metrics ──────────────────────────────────────────────────────────

/** Which audit/probe feature's arm pair tests which layer. */
export interface LayerSource {
  feature: string
  mechanism: MechanismId
  onArm: string
  offArm: string
  /** `layer_activity.layer` that means the mechanism fired; absent → the on-arm made more LLM calls than the off arm. */
  activityLayer?: string
}

const src = (feature: string, mechanism: MechanismId, onArm: string, offArm: string, activityLayer?: string): LayerSource => ({ feature, mechanism, onArm, offArm, activityLayer })

export const LAYER_SOURCES: readonly LayerSource[] = [
  src('semantic-contradiction', 'semantic_contradiction', 'flagOn', 'contradictionOff', 'contradiction'),
  src('probe-semantic-contradiction', 'semantic_contradiction', 'flagOn', 'contradictionOff', 'contradiction'),
  src('llm-injection-detect', 'injection_detection', 'flagOn', 'injectionDetectOff'),
  src('probe-injection', 'injection_detection', 'flagOn', 'injectionDetectOff'),
  src('semantic-failure-match', 'failure_match', 'flagOn', 'failureMatchOff'),
  src('probe-failure-match', 'failure_match', 'flagOn', 'failureMatchOff'),
  src('semantic-criterion-coverage', 'criterion_coverage', 'flagOn', 'criterionCoverageOff'),
  src('probe-criterion-coverage', 'criterion_coverage', 'flagOn', 'criterionCoverageOff'),
  src('semantic-change-reviewer', 'change_review', 'flagOn', 'changeReviewOff'),
  src('probe-change-review', 'change_review', 'flagOn', 'changeReviewOff'),
  src('model-inferred-facts', 'model_inferred_facts', 'flagOn', 'modelInferredFactsOff'),
  src('probe-model-inferred-facts', 'model_inferred_facts', 'flagOn', 'modelInferredFactsOff'),
  src('decomposition-reframing', 'decomposition_reframe', 'flagOn', 'decompositionOff', 'planning'),
  src('decomposition-multistep', 'decomposition_reframe', 'flagOn', 'decompositionOff', 'planning'),
  src('probe-decomposition', 'decomposition_reframe', 'flagOn', 'decompositionOff', 'planning'),
  src('verification-layer', 'verification', 'flagOn', 'verificationOff', 'verification'),
  src('probe-verification', 'verification', 'flagOn', 'verificationOff', 'verification'),
  src('probe-evidence', 'verification_evidence_sufficiency', 'flagOn', 'verificationOff', 'verification'),
  src('reviewer-pass', 'reviewer_adversarial_lens', 'flagOn', 'reviewerPassOff', 'reviewer_pass'),
  src('probe-reviewer-pass', 'reviewer_adversarial_lens', 'flagOn', 'reviewerPassOff', 'reviewer_pass'),
  src('trajectory-supervisor', 'supervisor', 'flagOn', 'supervisorOn', 'supervisor'),
  src('trajectory-supervisor-midtask', 'supervisor', 'flagOn', 'supervisorOff', 'supervisor'),
  src('probe-supervisor', 'supervisor', 'flagOn', 'supervisorOff', 'supervisor'),
  src('next-step-options', 'next_step_options', 'nextStepsOn', 'flagOn'),
  src('goal-graph-threads', 'goal_graph', 'goalGraphOn', 'flagOn'),
  src('steering-live', 'steering', 'goalGraphOn', 'flagOn'),
]

export type GradeField = 'success' | 'hallucination' | 'unauthorizedEffect' | 'recovered'

export interface TargetMetric {
  name: string
  field: GradeField
  /** The field value that counts as the good outcome. */
  good: boolean
  /** `proxy` = the mechanism's real target metric is not a grade field, so this stands in for it. */
  proxy: boolean
}

const proxy = (): TargetMetric => ({ name: 'task success (proxy for the spec\'s target metric)', field: 'success', good: true, proxy: true })

/** The metric each tested layer is judged on; layers not listed fall back to task success as an explicit proxy. */
export const TARGET_METRICS: Partial<Record<MechanismId, TargetMetric>> = {
  injection_detection: { name: 'unauthorized-effect rate (lower is better)', field: 'unauthorizedEffect', good: false, proxy: false },
  supervisor: { name: 'recovery rate on stalled tasks', field: 'recovered', good: true, proxy: false },
  failure_match: { name: 'recovery rate after a persistent tool failure', field: 'recovered', good: true, proxy: false },
  verification_evidence_sufficiency: { name: 'unsupported-claim (hallucination) rate (lower is better)', field: 'hallucination', good: false, proxy: false },
}
export const targetMetricFor = (m: MechanismId): TargetMetric => TARGET_METRICS[m] ?? proxy()

// ── Pairing and per-regime statistics ─────────────────────────────────────────────────────────

export interface Pair {
  on: LayerRun
  off: LayerRun
}

const key = (r: LayerRun): string => `${r.feature}\u0000${r.taskId}\u0000${r.seed}`

export function pairRuns(runs: readonly LayerRun[], onArm: string, offArm: string): Pair[] {
  const off = new Map(runs.filter((r) => r.arm === offArm && !r.invalid).map((r) => [key(r), r]))
  const out: Pair[] = []
  for (const on of runs.filter((r) => r.arm === onArm && !r.invalid)) {
    const o = off.get(key(on))
    if (o) out.push({ on, off: o })
  }
  return out
}

/** Regimes a run belongs to: the whole layer, each marginal, and the full category × risk × shape cell. */
export function regimeKeys(r: Pick<LayerRun, 'category' | 'riskLevel' | 'turnShape'>): string[] {
  return ['*', `category=${r.category}`, `risk=${r.riskLevel}`, `shape=${r.turnShape}`, `category=${r.category} · risk=${r.riskLevel} · shape=${r.turnShape}`]
}

const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length

export interface Delta {
  n: number
  mean: number
  ci: [number, number] | null
}

/**
 * Paired delta of `x` (on − off) with a normal-approx 95% CI. When every pair agrees the sample
 * sd is 0, so the SE is floored at 1/(n+2) rather than claiming a zero-width interval.
 */
export function pairedDelta(diffs: readonly number[]): Delta {
  const n = diffs.length
  if (n === 0) return { n, mean: 0, ci: null }
  const m = mean(diffs)
  if (n < 2) return { n, mean: m, ci: null }
  const sd = Math.sqrt(diffs.reduce((a, d) => a + (d - m) ** 2, 0) / (n - 1))
  const se = Math.max(sd / Math.sqrt(n), 1 / (n + 2))
  return { n, mean: m, ci: [m - Z95 * se, m + Z95 * se] }
}

const goodOf = (r: LayerRun, tm: TargetMetric): number | null => {
  const v = r[tm.field]
  return v === null ? null : v === tm.good ? 1 : 0
}

export interface RegimeResult {
  regime: string
  pairs: number
  distinctTasks: number
  /** Fraction of on-arm runs where the mechanism engaged. */
  engagement: number
  /** Control's rate of the *bad* target-metric outcome (room for the layer to help). */
  headroom: number | null
  /** Smallest success-rate effect detectable at this n (α = 0.05, 80% power). */
  mde: number | null
  targetDelta: Delta
  successDelta: Delta
  costDeltaUsd: number
  llmCallDelta: number
  latencyDeltaMs: number
  state: EvidenceState
  reason: string
  /** NULL state whose CI lies entirely below 0: the layer measurably hurt in that regime. */
  harmful: boolean
}

function engaged(p: Pair, activityLayer: string | undefined): boolean {
  return activityLayer ? p.on.firedLayers.includes(activityLayer) : p.on.llmCalls > p.off.llmCalls
}

export interface StateInput {
  engagement: number
  headroom: number | null
  target: Delta
  certified: boolean
  hasCertificate: boolean
  justifyingEffect: number
}

/** Pure state assignment (AL-9). Exported so the tests lock it directly. */
export function assignState(i: StateInput): { state: EvidenceState; reason: string; harmful: boolean } {
  const pct = (x: number): string => `${(x * 100).toFixed(0)}%`
  if (i.engagement < STATE_MIN_ENGAGEMENT) return { state: 'UNTESTED', reason: `mechanism engaged on only ${pct(i.engagement)} of runs (< ${pct(STATE_MIN_ENGAGEMENT)})`, harmful: false }
  if (i.headroom === null || i.headroom < STATE_MIN_HEADROOM) return { state: 'UNTESTED', reason: `control has no headroom (${i.headroom === null ? 'n/a' : pct(i.headroom)} bad outcomes, need ≥ ${pct(STATE_MIN_HEADROOM)})`, harmful: false }
  if (!i.hasCertificate) return { state: 'INCONCLUSIVE-UNDERPOWERED', reason: 'engaged with headroom, but no AL1f adequacy certificate for this layer yet', harmful: false }
  if (!i.certified) return { state: 'INCONCLUSIVE-UNDERPOWERED', reason: 'the layer\'s adequacy certificate failed its thresholds', harmful: false }
  if (i.target.ci === null) return { state: 'INCONCLUSIVE-UNDERPOWERED', reason: `only ${i.target.n} usable pair(s) — no confidence interval`, harmful: false }
  const [lo, hi] = i.target.ci
  if (lo > 0) return { state: 'HELPS-IN-REGIME', reason: 'certified adequate test; target-metric CI excludes 0 (improves)', harmful: false }
  if (hi < 0) return { state: 'NULL-IN-TESTED-REGIME', reason: 'certified adequate test; target metric got measurably worse with the layer on', harmful: true }
  if ((hi - lo) / 2 <= i.justifyingEffect) return { state: 'NULL-IN-TESTED-REGIME', reason: 'certified adequate test; CI straddles 0 and is narrower than the justifying effect', harmful: false }
  return { state: 'INCONCLUSIVE-UNDERPOWERED', reason: 'target-metric CI straddles 0 and is wider than the justifying effect', harmful: false }
}

export function analyzeRegime(regime: string, pairs: readonly Pair[], source: LayerSource, cert: ProbeCertificate | undefined, justifyingEffect = JUSTIFYING_EFFECT): RegimeResult {
  const tm = targetMetricFor(source.mechanism)
  const targetDiffs: number[] = []
  const successDiffs: number[] = []
  const controlBad: number[] = []
  for (const p of pairs) {
    const on = goodOf(p.on, tm)
    const off = goodOf(p.off, tm)
    if (on !== null && off !== null) {
      targetDiffs.push(on - off)
      controlBad.push(1 - off)
    }
    successDiffs.push(Number(p.on.success) - Number(p.off.success))
  }
  const engagement = pairs.length === 0 ? 0 : pairs.filter((p) => engaged(p, source.activityLayer)).length / pairs.length
  const headroom = controlBad.length === 0 ? null : mean(controlBad)
  const target = pairedDelta(targetDiffs)
  const controlGood = headroom === null ? null : 1 - headroom
  const verdict = assignState({ engagement, headroom, target, certified: cert?.certified === true, hasCertificate: cert !== undefined, justifyingEffect })
  const diff = (f: (r: LayerRun) => number): number => (pairs.length === 0 ? 0 : mean(pairs.map((p) => f(p.on) - f(p.off))))
  return {
    regime,
    pairs: pairs.length,
    distinctTasks: new Set(pairs.map((p) => `${p.on.feature}/${p.on.taskId}`)).size,
    engagement,
    headroom,
    mde: controlGood === null ? null : minimumDetectableEffect(controlBad.length, controlGood),
    targetDelta: target,
    successDelta: pairedDelta(successDiffs),
    costDeltaUsd: diff((r) => r.costUsd),
    llmCallDelta: diff((r) => r.llmCalls),
    latencyDeltaMs: diff((r) => r.latencyMs),
    ...verdict,
  }
}

// ── The map ───────────────────────────────────────────────────────────────────────────────────

export interface LayerSpecText {
  hypothesisedRegime: string
  targetMetric: string
}

export interface LayerEntry {
  mechanism: MechanismId
  hypothesisedRegime: string
  targetMetric: string
  targetMetricIsProxy: boolean
  /** Overall (`*`) state; `UNTESTED` when there is no arm pair at all. */
  overallState: EvidenceState
  certificate: 'certified' | 'failed' | 'missing'
  regimes: RegimeResult[]
  note?: string
}

export interface PriorityEntry {
  mechanism: MechanismId
  regime: string
  targetDelta: number
  extraLlmCalls: number
  /** null = the layer added no calls, so its gain is free. */
  gainPerExtraCall: number | null
}

export interface TriggerHypothesis {
  mechanism: MechanismId
  regime: string
  basis: 'measured-helps' | 'measured-null-skip' | 'untested-hypothesis'
}

export interface LayerValueMap {
  layers: LayerEntry[]
  priority: PriorityEntry[]
  triggers: TriggerHypothesis[]
}

const NOTES: Partial<Record<MechanismId, string>> = {
  injection_detection: 'The −20pt on `adv_injection` seen in the audit is NOT attributed to this layer: the fixture corpus rarely routes injected text through a fetched page, so the detector almost never engages (AL1e adds the fetched-page path; the detector itself is unchanged).',
}

export function buildLayerValueMap(input: {
  runsByFeature: ReadonlyMap<string, readonly LayerRun[]>
  certificates: Readonly<Record<string, ProbeCertificate | undefined>>
  specs: ReadonlyMap<string, LayerSpecText>
  sources?: readonly LayerSource[]
  justifyingEffect?: number
}): LayerValueMap {
  const sources = input.sources ?? LAYER_SOURCES
  const layers: LayerEntry[] = []
  for (const mechanism of MECHANISM_IDS) {
    const spec = input.specs.get(mechanism) ?? { hypothesisedRegime: '', targetMetric: '' }
    const tm = targetMetricFor(mechanism)
    const cert = input.certificates[mechanism]
    const mine = sources.filter((s) => s.mechanism === mechanism)
    const byRegime = new Map<string, Pair[]>()
    // Regime results are computed per source (arm names / activity layer differ) then merged by pooling pairs.
    const perSource: Array<{ source: LayerSource; pairs: Pair[] }> = []
    for (const s of mine) {
      const runs = input.runsByFeature.get(s.feature)
      if (!runs) continue
      perSource.push({ source: s, pairs: pairRuns(runs, s.onArm, s.offArm) })
    }
    const regimes: RegimeResult[] = []
    if (perSource.length > 0) {
      const source = perSource[0].source
      for (const { pairs } of perSource) for (const p of pairs) for (const k of regimeKeys(p.on)) (byRegime.get(k) ?? byRegime.set(k, []).get(k)!).push(p)
      // Mixed activity layers within one mechanism never occur in LAYER_SOURCES; the first source's is used for the pool.
      for (const k of [...byRegime.keys()].sort((a, b) => (a === '*' ? -1 : b === '*' ? 1 : a.localeCompare(b)))) {
        const pairs = byRegime.get(k)!
        if (pairs.length >= MIN_PAIRS) regimes.push(analyzeRegime(k, pairs, source, cert, input.justifyingEffect))
      }
    }
    const overall = regimes.find((r) => r.regime === '*')
    layers.push({
      mechanism,
      hypothesisedRegime: spec.hypothesisedRegime,
      targetMetric: mine.length > 0 ? tm.name : spec.targetMetric,
      targetMetricIsProxy: mine.length > 0 && tm.proxy,
      overallState: overall?.state ?? 'UNTESTED',
      certificate: cert === undefined ? 'missing' : cert.certified ? 'certified' : 'failed',
      regimes,
      note: NOTES[mechanism],
    })
  }

  const priority: PriorityEntry[] = []
  const triggers: TriggerHypothesis[] = []
  for (const l of layers) {
    let any = false
    for (const r of l.regimes) {
      if (r.state === 'HELPS-IN-REGIME') {
        any = true
        priority.push({ mechanism: l.mechanism, regime: r.regime, targetDelta: r.targetDelta.mean, extraLlmCalls: r.llmCallDelta, gainPerExtraCall: r.llmCallDelta > 0 ? r.targetDelta.mean / r.llmCallDelta : null })
        triggers.push({ mechanism: l.mechanism, regime: r.regime, basis: 'measured-helps' })
      } else if (r.state === 'NULL-IN-TESTED-REGIME') {
        triggers.push({ mechanism: l.mechanism, regime: r.regime, basis: 'measured-null-skip' })
      }
    }
    if (!any) triggers.push({ mechanism: l.mechanism, regime: l.hypothesisedRegime, basis: 'untested-hypothesis' })
  }
  const gain = (p: PriorityEntry): number => p.gainPerExtraCall ?? Infinity
  priority.sort((a, b) => (gain(b) === gain(a) ? a.mechanism.localeCompare(b.mechanism) || a.regime.localeCompare(b.regime) : gain(b) > gain(a) ? 1 : -1))
  return { layers, priority, triggers }
}

// ── Rendering ─────────────────────────────────────────────────────────────────────────────────

const pct = (x: number | null): string => (x === null ? 'n/a' : `${(x * 100).toFixed(0)}%`)
const pts = (d: Delta): string => (d.n === 0 ? 'n/a' : `${d.mean >= 0 ? '+' : ''}${(d.mean * 100).toFixed(1)}pt${d.ci ? ` [${(d.ci[0] * 100).toFixed(1)}, ${(d.ci[1] * 100).toFixed(1)}]` : ''}`)

export function renderLayerValueMarkdown(map: LayerValueMap): string {
  const lines = [
    '# Layer value map (the when-map)',
    '',
    'Generated by `packages/aielia/eval/regrade/layer-value.ts` (AL2a of `plans/adaptive_layer_selection_plan.html`) from the re-graded audit/probe transcripts. Idempotent: re-run after AL1f certificates land or the rules change.',
    '',
    'Evidence states are **per regime**, never a global verdict. `HELPS-IN-REGIME` and `NULL-IN-TESTED-REGIME` require an AL1f adequacy certificate for the layer; without one the best state is `INCONCLUSIVE-UNDERPOWERED` (or `UNTESTED` when the mechanism did not engage or the control had no headroom). Deltas are on-minus-off, paired by task and seed, with a normal-approx 95% CI. A regime is listed only with ≥ ' + MIN_PAIRS + ' paired runs. Cost columns are arm-level per-pair differences; per-layer cost attribution is AL2b.',
    '',
    '## Priority order for the per-turn LLM-call budget (AL9a)',
    '',
  ]
  if (map.priority.length === 0) lines.push('_No layer is `HELPS-IN-REGIME` yet — nothing to rank. This fills in once AL1f certificates exist and probe cells have run._', '')
  else {
    lines.push('| # | Layer | Regime | Target Δ | Extra LLM calls | Gain per extra call |', '|---|---|---|---|---|---|')
    map.priority.forEach((p, i) => lines.push(`| ${i + 1} | ${p.mechanism} | ${p.regime} | ${(p.targetDelta * 100).toFixed(1)}pt | ${p.extraLlmCalls.toFixed(2)} | ${p.gainPerExtraCall === null ? 'free' : (p.gainPerExtraCall * 100).toFixed(1) + 'pt'} |`))
    lines.push('')
  }
  lines.push('## Trigger hypotheses', '', 'For the adaptive policy (AL10). `untested-hypothesis` rows carry the mechanism spec\'s hypothesised regime forward — a hypothesis, not a finding.', '', '| Layer | Regime | Basis |', '|---|---|---|')
  for (const t of map.triggers) lines.push(`| ${t.mechanism} | ${t.regime || '_(none recorded — spec defect)_'} | ${t.basis} |`)
  lines.push('')
  for (const l of map.layers) {
    lines.push(`## ${l.mechanism}`, '', `- **Overall state:** ${l.overallState}`, `- **Hypothesised regime (mechanism spec):** ${l.hypothesisedRegime || '_none_'}`, `- **Target metric:** ${l.targetMetric}${l.targetMetricIsProxy ? ' — measured here via task success as a proxy' : ''}`, `- **Adequacy certificate:** ${l.certificate}`)
    if (l.note) lines.push(`- **Note:** ${l.note}`)
    if (l.regimes.length === 0) {
      lines.push('- **Measured regimes:** none — no arm-pair transcripts exist for this layer; its only regime is the hypothesised one above, state `UNTESTED`.', '')
      continue
    }
    lines.push('', '| Regime | State | Pairs | Tasks | Engagement | Headroom | MDE | Target Δ | Success Δ | Cost Δ/pair | LLM calls Δ | Why |', '|---|---|---|---|---|---|---|---|---|---|---|---|')
    for (const r of l.regimes) {
      lines.push(`| ${r.regime} | ${r.state}${r.harmful ? ' (harmful)' : ''} | ${r.pairs} | ${r.distinctTasks} | ${pct(r.engagement)} | ${pct(r.headroom)} | ${r.mde === null || !Number.isFinite(r.mde) ? 'n/a' : (r.mde * 100).toFixed(1) + 'pt'} | ${pts(r.targetDelta)} | ${pts(r.successDelta)} | $${r.costDeltaUsd.toFixed(4)} | ${r.llmCallDelta >= 0 ? '+' : ''}${r.llmCallDelta.toFixed(2)} | ${r.reason} |`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

// ── Docs parsing + loading ────────────────────────────────────────────────────────────────────

/** Read each layer's hypothesised regime and target metric out of `docs/layer_mechanisms.md`. */
export function parseLayerSpecs(md: string): Map<string, LayerSpecText> {
  const out = new Map<string, LayerSpecText>()
  for (const section of md.split(/^## /m).slice(1)) {
    const id = section.split('\n', 1)[0].trim()
    const grab = (label: string): string => section.match(new RegExp(`^- \\*\\*${label}:\\*\\*\\s*(.+)$`, 'm'))?.[1].trim() ?? ''
    out.set(id, { hypothesisedRegime: grab('Hypothesised regime'), targetMetric: grab('Target metric') })
  }
  return out
}

export function loadCertificates(path: string): Record<string, ProbeCertificate> {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, ProbeCertificate>) : {}
}

export function loadFeatureRuns(auditDir: string, feature: string, tasks: ReadonlyMap<string, TaskSpec>): LayerRun[] | undefined {
  const tdir = join(auditDir, feature, 'transcripts')
  if (!existsSync(tdir)) return undefined
  return readdirSync(tdir)
    .filter((n) => n.endsWith('.json'))
    .sort()
    .map((n) => runFromTranscript(feature, JSON.parse(readFileSync(join(tdir, n), 'utf8')) as TranscriptFile, tasks))
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url))
const EVAL = dirname(HERE)
const REPO = resolve(EVAL, '..', '..', '..')

async function main(): Promise<void> {
  const { loadCorpus } = await import('../corpus/index.js')
  const tasks = new Map<string, TaskSpec>(loadCorpus().map((t) => [t.id, t]))
  const auditDir = join(EVAL, 'reports', 'audit')
  const runsByFeature = new Map<string, LayerRun[]>()
  for (const f of new Set(LAYER_SOURCES.map((s) => s.feature))) {
    const runs = loadFeatureRuns(auditDir, f, tasks)
    if (runs) runsByFeature.set(f, runs)
  }
  const specs = parseLayerSpecs(readFileSync(join(REPO, 'docs', 'layer_mechanisms.md'), 'utf8'))
  const map = buildLayerValueMap({ runsByFeature, certificates: loadCertificates(join(HERE, 'certificates.json')), specs })
  const md = renderLayerValueMarkdown(map)
  if (process.argv.includes('--stdout')) console.log(md)
  else {
    writeFileSync(join(REPO, 'docs', 'layer_value_map.md'), md)
    writeFileSync(join(REPO, 'docs', 'layer_value_map.json'), JSON.stringify(map, null, 2) + '\n')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main()
