// Differential runtime conformance: each fixtures-runtime/*.json scenario runs through the TS HarnessRuntime and the Python
// twin; the trace projections (node order, task statuses, strategy, failures, beliefs, control state, halts…) must match.
//   PYTHON=<python> node scripts/harness-conformance/compare-runtime.mjs [scenario-substring]
// Known, reviewed differences live in known-discrepancies-runtime.json ({ "<fixture>": "<reason>" }); they are reported
// as tracked, not failed, and a tracked fixture that starts passing is flagged so the entry can be removed.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PY = process.env.PYTHON ?? 'python3'
const filter = process.argv[2] ?? ''
const known = existsSync(join(here, 'known-discrepancies-runtime.json'))
  ? JSON.parse(readFileSync(join(here, 'known-discrepancies-runtime.json'), 'utf8')) : {}

// Random id suffixes (rebuilt-task-0-ab12) are not behaviour: normalise before comparing.
const norm = (o) => JSON.parse(JSON.stringify(o).replace(/(rebuilt-task-\d+)-[0-9a-z]+/g, '$1'))
const envOf = (f) => ({ ...process.env, ...(JSON.parse(readFileSync(f, 'utf8')).env ?? {}) })
const runTs = (f) => norm(JSON.parse(execFileSync('npx', ['tsx', join(here, 'run-ts-runtime.mts'), f], { encoding: 'utf8', cwd: here, env: envOf(f), maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] })))
const runPy = (f) => norm(JSON.parse(execFileSync(PY, [join(here, 'run_py_runtime.py'), f], { encoding: 'utf8', env: envOf(f), maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] })))

function diff(a, b, path = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return []
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) => diff(a[k], b[k], `${path}.${k}`))
  }
  return [`${path}: ts=${JSON.stringify(a)} py=${JSON.stringify(b)}`]
}

const dir = join(here, 'fixtures-runtime')
const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f.includes(filter)).sort()
let pass = 0, tracked = 0, fail = 0
for (const f of files) {
  const name = f.replace(/\.json$/, '')
  try {
    const d = diff(runTs(join(dir, f)), runPy(join(dir, f)))
    if (d.length === 0) {
      if (known[name]) { fail++; console.log(`FAIL  ${name}: now passes — remove it from known-discrepancies-runtime.json`) }
      else { pass++; console.log(`PASS  ${name}`) }
    } else if (known[name]) { tracked++; console.log(`TRACK ${name}: ${known[name]}`) }
    else { fail++; console.log(`FAIL  ${name}\n   ${d.slice(0, 8).join('\n   ')}`) }
  } catch (err) {
    fail++
    console.log(`FAIL  ${name}: ${String(err.stderr ?? err.message).split('\n').slice(0, 8).join('\n   ')}`)
  }
}
console.log(`\n${pass} passed, ${tracked} tracked discrepancies, ${fail} failed (of ${files.length} scenarios)`)
process.exit(fail === 0 ? 0 : 1)
