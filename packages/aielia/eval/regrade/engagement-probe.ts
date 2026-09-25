/**
 * Engagement + headroom probe (AL1b of plans/adaptive_layer_selection_plan.html).
 *
 * A layer test is only informative if the layer *engages*, the control has *headroom*, the
 * scenarios are *broad*, the judge is *reliable* and there is enough *power*. This tool takes the
 * runs of one mechanism's stress slice (loaded from a run's saved transcripts by `loadProbeRuns`,
 * or built directly in tests) and emits either a certificate or the list of failed thresholds.
 *
 * Pure functions except `loadProbeRuns` / the CLI at the bottom. Test/tooling only.
 *
 *   npx tsx eval/regrade/engagement-probe.ts --dir=<audit feature dir> --mechanism=<id> \
 *        --on=flagOn --off=<offArm> [--seeds=3] [--justifying-effect=0.1] [--judge-agree=<n>/<total>]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { TaskSpec } from '../corpus/schema.js'
import { checkMechanismTasks } from '../corpus/mechanism-rules.js'

/** Certificate thresholds (per regime) — the plan's AL1b numbers. */
export const MIN_ENGAGEMENT = 0.6
export const MIN_CONTROL_FAILURE = 0.25
export const MAX_CONTROL_FAILURE = 0.75
export const MIN_JUDGE_AGREEMENT = 0.95
/** z(α/2 = 0.025) + z(power = 0.80). */
const Z_ALPHA_PLUS_BETA = 1.96 + 0.8416

export interface ProbeRun {
  taskId: string
  arm: string
  seed: number | string
  /** From the task spec; a run of an untagged task is ignored by the probe. */
  role: 'stress' | 'calm-control' | undefined
  success: boolean
  /** Excluded from every rate (an INVALID_TASK verdict is not evidence either way). */
  invalid: boolean
  /** Layers (per `layer_activity` events) that fired at least once during the run. */
  firedLayers: readonly string[]
  /** `llm_request` count — the cost-side engagement signal for layers with no activity event. */
  llmCalls: number
  /** Normalised final reply, for the layer-on vs layer-off indistinguishability check. */
  reply: string
}

export interface ProbeInput {
  mechanism: string
  /** The `layer_activity.layer` name that means this mechanism fired; absent → LLM-call delta is used. */
  activityLayer?: string
  onArm: string
  offArm: string
  runs: readonly ProbeRun[]
  /** The mechanism's tagged tasks, for the family/breadth minimums. */
  tasks: readonly TaskSpec[]
  /** Double-pass judge agreement: agreeing verdicts / verdicts compared. */
  judge: { agree: number; total: number }
  plannedSeeds: number
  /** Smallest success-rate effect that would justify the layer's cost. */
  justifyingEffect: number
}

export interface ThresholdResult {
  name: 'engagement' | 'headroom' | 'breadth' | 'judge_agreement' | 'mde'
  pass: boolean
  value: number | null
  threshold: string
  detail: string
}

export interface ProbeCertificate {
  mechanism: string
  certified: boolean
  thresholds: ThresholdResult[]
  /** Human-readable list of the failed thresholds (empty when certified). */
  failed: string[]
  nonDiagnosticTasks: string[]
  stressRuns: number
}

const valid = (r: ProbeRun): boolean => !r.invalid
const rate = (xs: readonly boolean[]): number | null => (xs.length === 0 ? null : xs.filter(Boolean).length / xs.length)

/** Did the layer engage on this on-arm run? Activity event if the layer has one, else it added LLM calls over the off arm. */
function engaged(run: ProbeRun, activityLayer: string | undefined, offCalls: number | undefined): boolean {
  if (activityLayer) return run.firedLayers.includes(activityLayer)
  return offCalls !== undefined && run.llmCalls > offCalls
}

const key = (r: ProbeRun): string => `${r.taskId}\u0000${r.seed}`

/** Fraction of on-arm stress runs where the layer engaged; `null` with no runs. */
export function engagementRate(input: Pick<ProbeInput, 'runs' | 'onArm' | 'offArm' | 'activityLayer'>): number | null {
  const off = new Map(input.runs.filter((r) => r.arm === input.offArm && r.role === 'stress').map((r) => [key(r), r.llmCalls]))
  const on = input.runs.filter((r) => r.arm === input.onArm && r.role === 'stress' && valid(r))
  return rate(on.map((r) => engaged(r, input.activityLayer, off.get(key(r)))))
}

/** Control (layer-off) failure rate over stress runs; `null` with no runs. */
export function controlFailureRate(runs: readonly ProbeRun[], offArm: string): number | null {
  return rate(runs.filter((r) => r.arm === offArm && r.role === 'stress' && valid(r)).map((r) => !r.success))
}

/**
 * Minimum detectable success-rate effect (two-sided α = 0.05, 80% power, two proportions) for
 * `n` stress runs per arm at control success rate `p`. Conservative: treats runs as independent.
 */
export function minimumDetectableEffect(n: number, controlSuccess: number): number {
  if (n <= 0) return Infinity
  const p = Math.min(Math.max(controlSuccess, 0.05), 0.95)
  return Z_ALPHA_PLUS_BETA * Math.sqrt((2 * p * (1 - p)) / n)
}

/**
 * Stress tasks where layer-on and layer-off runs are indistinguishable (same success, same reply,
 * same LLM-call count, every seed) *and* the layer never fired — flagged for replacement.
 */
export function nonDiagnosticTasks(input: Pick<ProbeInput, 'runs' | 'onArm' | 'offArm' | 'activityLayer'>): string[] {
  const stress = input.runs.filter((r) => r.role === 'stress' && valid(r))
  const ids = [...new Set(stress.map((r) => r.taskId))].sort()
  const out: string[] = []
  for (const id of ids) {
    const on = stress.filter((r) => r.taskId === id && r.arm === input.onArm)
    const off = new Map(stress.filter((r) => r.taskId === id && r.arm === input.offArm).map((r) => [String(r.seed), r]))
    if (on.length === 0) continue
    const everFired = on.some((r) => (input.activityLayer ? r.firedLayers.includes(input.activityLayer) : false))
    const allSame = on.every((r) => {
      const o = off.get(String(r.seed))
      return o !== undefined && o.success === r.success && o.reply === r.reply && o.llmCalls === r.llmCalls
    })
    if (allSame && !everFired) out.push(id)
  }
  return out
}

export function probe(input: ProbeInput): ProbeCertificate {
  const stress = input.runs.filter((r) => r.role === 'stress' && r.arm === input.onArm && valid(r))
  const thresholds: ThresholdResult[] = []

  const eng = engagementRate(input)
  thresholds.push({
    name: 'engagement', value: eng, threshold: `>= ${MIN_ENGAGEMENT}`,
    pass: eng !== null && eng >= MIN_ENGAGEMENT,
    detail: eng === null ? 'no valid stress runs on the layer-on arm' : `layer engaged on ${(eng * 100).toFixed(0)}% of stress runs`,
  })

  const fail = controlFailureRate(input.runs, input.offArm)
  thresholds.push({
    name: 'headroom', value: fail, threshold: `${MIN_CONTROL_FAILURE}..${MAX_CONTROL_FAILURE}`,
    pass: fail !== null && fail >= MIN_CONTROL_FAILURE && fail <= MAX_CONTROL_FAILURE,
    detail: fail === null ? 'no valid stress runs on the control arm' : `control fails ${(fail * 100).toFixed(0)}% of stress runs${fail < MIN_CONTROL_FAILURE ? ' (saturated — no headroom)' : fail > MAX_CONTROL_FAILURE ? ' (too hard — floor effect)' : ''}`,
  })

  const breadth = checkMechanismTasks(input.mechanism, input.tasks)
  thresholds.push({
    name: 'breadth', value: breadth.length, threshold: '0 rule violations',
    pass: breadth.length === 0,
    detail: breadth.length === 0 ? 'family/stress/calm-control/note/duplicate rules all hold' : breadth.join('; '),
  })

  const agreement = input.judge.total > 0 ? input.judge.agree / input.judge.total : null
  thresholds.push({
    name: 'judge_agreement', value: agreement, threshold: `>= ${MIN_JUDGE_AGREEMENT}`,
    pass: agreement !== null && agreement >= MIN_JUDGE_AGREEMENT,
    detail: agreement === null ? 'no double-pass verdicts to compare' : `${input.judge.agree}/${input.judge.total} verdicts agree`,
  })

  const nPerArm = stress.length
  const mde = fail === null ? Infinity : minimumDetectableEffect(nPerArm, 1 - fail)
  thresholds.push({
    name: 'mde', value: Number.isFinite(mde) ? mde : null, threshold: `<= ${input.justifyingEffect}`,
    pass: mde <= input.justifyingEffect,
    detail: `n=${nPerArm} stress runs/arm (planned seeds ${input.plannedSeeds}) can detect a ${Number.isFinite(mde) ? (mde * 100).toFixed(1) + ' pts' : 'no'} effect; the layer is worth its cost only at ${(input.justifyingEffect * 100).toFixed(1)} pts`,
  })

  const failed = thresholds.filter((t) => !t.pass).map((t) => `${t.name}: ${t.detail} (need ${t.threshold})`)
  return {
    mechanism: input.mechanism,
    certified: failed.length === 0,
    thresholds,
    failed,
    nonDiagnosticTasks: nonDiagnosticTasks(input),
    stressRuns: stress.length,
  }
}

// ── Loading runs from a benchmark run's saved transcripts ─────────────────────────────────────

interface TranscriptFile {
  task: string
  arm: string
  seed: number | string
  events?: Array<{ kind: string; detail?: { kind?: string; layer?: string; fired?: boolean } }>
  grade?: { success?: boolean; invalid?: boolean; verdict?: string }
  replyPreview?: string
}

export function runFromTranscript(t: TranscriptFile, tasks: ReadonlyMap<string, TaskSpec>): ProbeRun {
  const events = t.events ?? []
  const fired = new Set<string>()
  for (const e of events) {
    if (e.kind === 'trace' && e.detail?.kind === 'layer_activity' && e.detail.fired && e.detail.layer) fired.add(e.detail.layer)
  }
  return {
    taskId: t.task,
    arm: t.arm,
    seed: t.seed,
    role: tasks.get(t.task)?.role,
    success: t.grade?.success === true,
    invalid: t.grade?.invalid === true || t.grade?.verdict === 'INVALID_TASK',
    firedLayers: [...fired].sort(),
    llmCalls: events.filter((e) => e.kind === 'llm_request').length,
    reply: (t.replyPreview ?? '').trim().replace(/\s+/g, ' '),
  }
}

/** Read every `*.json` transcript in `<dir>/transcripts` (or `dir` itself when it holds them). */
export function loadProbeRuns(dir: string, tasks: ReadonlyMap<string, TaskSpec>): ProbeRun[] {
  const tdir = existsSync(join(dir, 'transcripts')) ? join(dir, 'transcripts') : dir
  return readdirSync(tdir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => runFromTranscript(JSON.parse(readFileSync(join(tdir, f), 'utf8')) as TranscriptFile, tasks))
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { loadCorpus } = await import('../corpus/index.js')
  const { mechanismOf } = await import('../corpus/mechanism-rules.js')
  const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')] }))
  for (const need of ['dir', 'mechanism', 'on', 'off']) if (!args[need]) throw new Error(`missing --${need}=`)
  const corpus = loadCorpus()
  const tasks = new Map(corpus.map((t) => [t.id, t]))
  const [agree, total] = (args['judge-agree'] ?? '0/0').split('/').map(Number)
  const cert = probe({
    mechanism: args.mechanism,
    activityLayer: args.layer || undefined,
    onArm: args.on,
    offArm: args.off,
    runs: loadProbeRuns(args.dir, tasks),
    tasks: corpus.filter((t) => mechanismOf(t) === args.mechanism && t.role),
    judge: { agree, total },
    plannedSeeds: Number(args.seeds ?? 3),
    justifyingEffect: Number(args['justifying-effect'] ?? 0.1),
  })
  console.log(JSON.stringify(cert, null, 2))
  process.exitCode = cert.certified ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main()
