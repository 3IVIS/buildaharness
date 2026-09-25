/**
 * Corpus saturation report (AL1b of plans/adaptive_layer_selection_plan.html).
 *
 * Over the *existing* audit corpus, list every (feature, category) cell where both arms pass
 * > 90% (no headroom — the corpus cannot tell them apart) or the candidate layer engaged on
 * < 30% of runs (the corpus never exercises it). This is the standing evidence for F1: a null
 * verdict on such a cell says nothing about the layer.
 *
 * "Engaged" here is arm-agnostic and conservative: the candidate run is observably different from
 * the control run of the same task and seed (different LLM-call count, success or reply). It is
 * the coarse whole-feature analogue of the per-layer signal `engagement-probe.ts` uses.
 *
 *   npx tsx eval/regrade/saturation.ts            # write docs/corpus_saturation.md
 *   npx tsx eval/regrade/saturation.ts --stdout   # print, write nothing
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runFromTranscript, type ProbeRun } from './engagement-probe.js'
import type { TaskSpec } from '../corpus/schema.js'

export const SATURATION_PASS_RATE = 0.9
export const LOW_ENGAGEMENT = 0.3

export interface SaturationRun extends ProbeRun {
  category: string
}

export interface SaturationCell {
  feature: string
  category: string
  control: string
  candidate: string
  runsPerArm: number
  controlPass: number | null
  candidatePass: number | null
  engagement: number | null
  reasons: Array<'both_arms_saturated' | 'low_engagement'>
}

const passRate = (rs: readonly ProbeRun[]): number | null => (rs.length === 0 ? null : rs.filter((r) => r.success).length / rs.length)
const key = (r: ProbeRun): string => `${r.taskId}\u0000${r.seed}`

/** Pure: analyse one feature's runs, one cell per task category. Cells with no flag are omitted. */
export function analyzeFeature(feature: string, control: string, candidate: string, runs: readonly SaturationRun[]): SaturationCell[] {
  const cells: SaturationCell[] = []
  const usable = runs.filter((r) => !r.invalid)
  for (const category of [...new Set(usable.map((r) => r.category))].sort()) {
    const inCat = usable.filter((r) => r.category === category)
    const ctl = inCat.filter((r) => r.arm === control)
    const cand = inCat.filter((r) => r.arm === candidate)
    if (ctl.length === 0 || cand.length === 0) continue
    const ctlByKey = new Map(ctl.map((r) => [key(r), r]))
    const paired = cand.filter((r) => ctlByKey.has(key(r)))
    const engaged = paired.filter((r) => {
      const c = ctlByKey.get(key(r))!
      return r.llmCalls !== c.llmCalls || r.success !== c.success || r.reply !== c.reply
    })
    const engagement = paired.length === 0 ? null : engaged.length / paired.length
    const controlPass = passRate(ctl)
    const candidatePass = passRate(cand)
    const reasons: SaturationCell['reasons'] = []
    if (controlPass !== null && candidatePass !== null && controlPass > SATURATION_PASS_RATE && candidatePass > SATURATION_PASS_RATE) reasons.push('both_arms_saturated')
    if (engagement !== null && engagement < LOW_ENGAGEMENT) reasons.push('low_engagement')
    if (reasons.length) cells.push({ feature, category, control, candidate, runsPerArm: Math.min(ctl.length, cand.length), controlPass, candidatePass, engagement, reasons })
  }
  return cells
}

const pct = (x: number | null): string => (x === null ? 'n/a' : `${(x * 100).toFixed(0)}%`)

export function renderSaturationMarkdown(cells: readonly SaturationCell[], featuresScanned: number, generated: string): string {
  const lines = [
    '# Corpus saturation report',
    '',
    `Generated ${generated} by \`packages/aielia/eval/regrade/saturation.ts\` over ${featuresScanned} audit feature(s) under \`eval/reports/audit/\`.`,
    '',
    `A (feature, category) cell is listed when **both arms pass > ${SATURATION_PASS_RATE * 100}%** (no headroom) or the candidate layer **engaged on < ${LOW_ENGAGEMENT * 100}%** of runs (the corpus rarely exercises it; engagement = the candidate run differs from the control run of the same task and seed in LLM-call count, success or reply).`,
    'A null verdict on a listed cell is uninformative about the layer — this is the standing evidence for F1 of `plans/adaptive_layer_selection_plan.html`.',
    '',
  ]
  if (cells.length === 0) {
    lines.push('_No saturated or low-engagement cells found._', '')
    return lines.join('\n')
  }
  lines.push('| Feature | Category | Control pass | Candidate pass | Engagement | Runs/arm | Why listed |', '|---|---|---|---|---|---|---|')
  for (const c of cells) {
    lines.push(`| ${c.feature} | ${c.category} | ${pct(c.controlPass)} | ${pct(c.candidatePass)} | ${pct(c.engagement)} | ${c.runsPerArm} | ${c.reasons.map((r) => (r === 'both_arms_saturated' ? 'both arms saturated' : 'low engagement')).join(', ')} |`)
  }
  lines.push('')
  return lines.join('\n')
}

// ── CLI: read every audit feature's transcripts ───────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url))
const EVAL = dirname(HERE)

async function main(): Promise<void> {
  const { loadCorpus } = await import('../corpus/index.js')
  const tasks = new Map<string, TaskSpec>(loadCorpus().map((t) => [t.id, t]))
  const manifest = JSON.parse(readFileSync(join(EVAL, 'audit', 'manifest.json'), 'utf8')) as { features: Array<{ id: string; arms: [string, string] }> }
  const auditDir = join(EVAL, 'reports', 'audit')
  const cells: SaturationCell[] = []
  let scanned = 0
  for (const f of manifest.features) {
    const tdir = join(auditDir, f.id, 'transcripts')
    if (!existsSync(tdir)) continue
    const runs: SaturationRun[] = readdirSync(tdir)
      .filter((n) => n.endsWith('.json'))
      .map((n) => {
        const raw = JSON.parse(readFileSync(join(tdir, n), 'utf8'))
        return { ...runFromTranscript(raw, tasks), category: tasks.get(raw.task)?.category ?? 'unknown' }
      })
    scanned++
    cells.push(...analyzeFeature(f.id, f.arms[0], f.arms[1], runs))
  }
  const md = renderSaturationMarkdown(cells, scanned, new Date().toISOString().slice(0, 10))
  if (process.argv.includes('--stdout')) console.log(md)
  else writeFileSync(resolve(EVAL, '..', '..', '..', 'docs', 'corpus_saturation.md'), md)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main()
