/**
 * AL1f of plans/adaptive_layer_selection_plan.html: run the engagement probe over every finalized
 * `probe-*` audit cell and write `eval/regrade/certificates.json` (`{ [mechanism]: ProbeCertificate }`),
 * which `layer-value.ts` (AL2a) and `adaptive-analysis.ts` (AL11b) read.
 *
 * Judge agreement comes from a second, independent judge pass over a random sample of the probe
 * transcripts (`regrade.py --features probe-* --sample N`, output in `consistency/probe-pass/`):
 * the sampled row's second verdict is compared with the verdict the run's own judge recorded. The
 * sample is pooled across all probe cells (too few rows per cell to be meaningful alone).
 *
 *   npx tsx eval/regrade/certify-probes.ts            # write certificates.json
 *   npx tsx eval/regrade/certify-probes.ts --stdout   # print, write nothing
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { probe, loadProbeRuns, type ProbeCertificate } from './engagement-probe.js'
import { LAYER_SOURCES } from './layer-value.js'
import { mechanismOf } from '../corpus/mechanism-rules.js'
import type { TaskSpec } from '../corpus/schema.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const EVAL = resolve(HERE, '..')

interface SecondPassRecord {
  oldSuccess?: boolean
  verdict?: string
}

/** Pooled agreement between the run's own verdict and an independent second pass; INVALID/errored rows are not compared. */
export function judgeAgreement(records: readonly SecondPassRecord[]): { agree: number; total: number } {
  const compared = records.filter((r) => r.verdict === 'PASS' || r.verdict === 'FAIL')
  return { agree: compared.filter((r) => (r.verdict === 'PASS') === (r.oldSuccess === true)).length, total: compared.length }
}

export function loadSecondPass(dir: string): SecondPassRecord[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => readdirSync(join(dir, d.name)).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, d.name, f), 'utf8')) as SecondPassRecord))
}

/** Planned seeds and the smallest success effect that would justify a layer's cost, as used by the audit's probe cells. */
export const PLANNED_SEEDS = 3
export const JUSTIFYING_EFFECT = 0.1

export function certifyAll(corpus: readonly TaskSpec[], auditDir: string, secondPass: readonly SecondPassRecord[]): Record<string, ProbeCertificate> {
  const tasks = new Map(corpus.map((t) => [t.id, t]))
  const judge = judgeAgreement(secondPass)
  const out: Record<string, ProbeCertificate> = {}
  for (const s of LAYER_SOURCES.filter((x) => x.feature.startsWith('probe-'))) {
    const dir = join(auditDir, s.feature)
    if (!existsSync(join(dir, 'transcripts'))) continue
    out[s.mechanism] = probe({
      mechanism: s.mechanism,
      activityLayer: s.activityLayer,
      onArm: s.onArm,
      offArm: s.offArm,
      runs: loadProbeRuns(dir, tasks),
      tasks: corpus.filter((t) => mechanismOf(t) === s.mechanism && t.role),
      judge,
      plannedSeeds: PLANNED_SEEDS,
      justifyingEffect: JUSTIFYING_EFFECT,
    })
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)))
}

async function main(): Promise<void> {
  const { loadCorpus } = await import('../corpus/index.js')
  const certs = certifyAll(loadCorpus(), join(EVAL, 'reports', 'audit'), loadSecondPass(join(HERE, 'consistency', 'probe-pass')))
  const json = JSON.stringify(certs, null, 2) + '\n'
  if (process.argv.includes('--stdout')) console.log(json)
  else writeFileSync(join(HERE, 'certificates.json'), json)
  for (const [m, c] of Object.entries(certs)) console.log(`${c.certified ? 'CERTIFIED' : 'UNCERTIFIED'}  ${m}${c.failed.length ? '\n    - ' + c.failed.join('\n    - ') : ''}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main()
