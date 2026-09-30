// Cross-runtime checkpoint conformance: a checkpoint written by one runtime must resume in the other and reach the
// same outcome as an uninterrupted run. Checks both directions for both pause points.
//   node scripts/harness-conformance/compare-checkpoint.mjs
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PY = process.env.PYTHON ?? 'python3'
const run = {
  ts: (...args) => execFileSync('npx', ['tsx', join(here, 'run-ts-checkpoint.mts'), ...args], { encoding: 'utf8', cwd: here, maxBuffer: 1 << 26 }),
  py: (...args) => execFileSync(PY, [join(here, 'run_py_checkpoint.py'), ...args], { encoding: 'utf8', maxBuffer: 1 << 26 }),
}

const dir = mkdtempSync(join(tmpdir(), 'xrun-'))
const baselines = { ts: JSON.parse(run.ts('baseline')), py: JSON.parse(run.py('baseline')) }
let failures = 0
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

if (!eq(baselines.ts, baselines.py)) {
  failures++
  console.log('FAIL  baseline (uninterrupted) runs differ', baselines.ts, baselines.py)
} else console.log('PASS  baseline: both runtimes finish identically', JSON.stringify(baselines.ts))

for (const pauseKind of ['proposal', 'iteration']) {
  for (const [writer, reader] of [['ts', 'py'], ['py', 'ts']]) {
    const name = `${writer}-pause(${pauseKind}) -> ${reader}-resume`
    try {
      const file = join(dir, `${writer}-${pauseKind}.json`)
      writeFileSync(file, run[writer]('pause', pauseKind))
      const got = JSON.parse(run[reader]('resume', file))
      if (eq(got, baselines[reader])) console.log(`PASS  ${name}`)
      else { failures++; console.log(`FAIL  ${name}\n  expected ${JSON.stringify(baselines[reader])}\n  got      ${JSON.stringify(got)}`) }
    } catch (err) {
      failures++
      console.log(`FAIL  ${name}: ${String(err.stderr ?? err.message).split('\n').slice(0, 6).join('\n')}`)
    }
  }
}
console.log(failures === 0 ? '\nall checkpoint conformance checks passed' : `\n${failures} checkpoint conformance check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
