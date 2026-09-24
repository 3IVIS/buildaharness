#!/usr/bin/env node
/**
 * Run the feature-value audit matrix in parallel — one child process per (feature, seed) cell.
 *
 *   node scripts/run-audit-parallel.mjs --features=steering-live,goal-graph-threads --seeds=3 --concurrency=4
 *
 * Why processes, not in-process concurrency: an arm's feature toggle is set on `process.env` around
 * its turn (eval/arms.ts `runAssistant`), so two arms running at once in one process would corrupt
 * each other's flags. Separate `run-harness-benchmark.ts` processes share nothing.
 *
 * Each cell writes eval/reports/audit/<feature>/seed<N>.json (the file `audit/cli.ts
 * build-multiseed` reads), its transcripts to eval/reports/audit/<feature>/transcripts/, and its
 * console log to eval/reports/audit/<feature>/logs/seed<N>.log. A cell whose seed<N>.json already
 * exists is skipped, so an interrupted run resumes; `--force` re-runs everything selected.
 *
 * Flags: --features=<ids|all-queued> --seeds=<n> (default: the manifest entry's `seeds`)
 *        --concurrency=<n> (default 4) --model=<alias> (default sonnet) --dry-run --force
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, createWriteStream } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const AUDIT_DIR = join(PKG_ROOT, 'eval', 'reports', 'audit')
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=')
const flag = (name) => process.argv.includes(`--${name}`)

const manifest = JSON.parse(readFileSync(join(PKG_ROOT, 'eval', 'audit', 'manifest.json'), 'utf8'))
const wanted = arg('features')
if (!wanted) {
  console.error('missing --features=<id,id,...|all-queued>')
  process.exit(2)
}
const features =
  wanted === 'all-queued'
    ? manifest.features.filter((f) => f.status === 'queued')
    : wanted.split(',').map((id) => {
        const f = manifest.features.find((x) => x.id === id.trim())
        if (!f) {
          console.error(`feature "${id}" is not in manifest.json`)
          process.exit(2)
        }
        return f
      })

const concurrency = Math.max(1, Number.parseInt(arg('concurrency') ?? '4', 10) || 4)
const model = arg('model') ?? 'sonnet'

const cells = []
for (const f of features) {
  const seeds = Number.parseInt(arg('seeds') ?? String(f.seeds ?? 3), 10)
  for (let n = 1; n <= seeds; n++) {
    const dir = join(AUDIT_DIR, f.id)
    const out = join(dir, `seed${n}.json`)
    if (existsSync(out) && !flag('force')) continue
    const args = [
      'tsx',
      'scripts/run-harness-benchmark.ts',
      `--arms=${f.arms.join(',')}`,
      ...(f.slice ? [`--slice=${f.slice}`] : []),
      ...(f.excludeSlice ? [`--exclude-slice=${f.excludeSlice}`] : []),
      '--seeds=1',
      `--seed-tag=${n}`,
      `--model=${model}`,
      `--judge-model=${model}`,
      `--transcripts=${join(dir, 'transcripts')}`,
      `--out=${out}`,
      '--no-md',
    ]
    cells.push({ feature: f.id, seed: n, dir, args })
  }
}

console.log(`${cells.length} cell(s) to run, concurrency ${concurrency}, model ${model}`)
for (const c of cells) console.log(`  ${c.feature} seed${c.seed}`)
if (flag('dry-run') || cells.length === 0) process.exit(0)

let next = 0
let failed = 0
const startedAt = Date.now()

function runCell(c) {
  return new Promise((done) => {
    mkdirSync(join(c.dir, 'logs'), { recursive: true })
    const log = createWriteStream(join(c.dir, 'logs', `seed${c.seed}.log`))
    const t0 = Date.now()
    console.log(`▶ ${c.feature} seed${c.seed}`)
    const child = spawn('npx', c.args, { cwd: PKG_ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.pipe(log, { end: false })
    child.stderr.pipe(log, { end: false })
    child.on('close', (code) => {
      log.end()
      const mins = ((Date.now() - t0) / 60000).toFixed(1)
      if (code === 0) console.log(`✔ ${c.feature} seed${c.seed} (${mins} min)`)
      else {
        failed += 1
        console.error(`✖ ${c.feature} seed${c.seed} exited ${code} after ${mins} min — see logs/seed${c.seed}.log`)
      }
      done()
    })
  })
}

async function worker() {
  while (next < cells.length) {
    const c = cells[next++]
    await runCell(c)
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, cells.length) }, worker))
console.log(`\nfinished in ${((Date.now() - startedAt) / 60000).toFixed(1)} min — ${cells.length - failed}/${cells.length} cells ok`)
process.exit(failed > 0 ? 1 : 0)
