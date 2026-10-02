#!/usr/bin/env node
// Standalone TS-vs-Python conformance runner for the agent-memory contract (M8 of the internal plan):
// budgeted render, keyed supersession, the write gate, the write-route table, the tier rule and the
// audit log / undo — the companion to compare-supervisor.mjs and friends.
//
// Usage: node scripts/harness-conformance/compare-memory.mjs [--ts-only]
//
// For each fixtures-memory/*.json, runs the scenario through the real TS MemoryService
// (run-ts-memory.mts) and the Python AgentMemoryService (run_py_memory.py), both with an injected
// clock and plain-data judgements (no model), and diffs { steps, final } with keys deep-sorted
// (field order is not part of the contract). A fixture may also carry:
//   expected        hand-reviewed oracle, matched as a SUBSET against BOTH runtimes (objects: listed keys
//                   must match; arrays: same length, element-wise subset; {"$absent": true}: key must be
//                   absent; {"$length": n, "$first": x, "$last": y}: array shape check).
//   mustNotContain  strings that must appear nowhere in either runtime's output (secret canaries).
// A fixture listed in known-discrepancies-memory.json is a tracked discrepancy (exit 0); any other
// mismatch is an untracked regression (exit 1). --ts-only checks TS against expected/mustNotContain only.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, 'fixtures-memory')
const knownDiscrepancies = JSON.parse(readFileSync(join(__dirname, 'known-discrepancies-memory.json'), 'utf-8'))
const tsOnly = process.argv.includes('--ts-only')

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]))
  }
  return value
}

function subset(exp, act, path, errors) {
  if (exp && typeof exp === 'object' && !Array.isArray(exp)) {
    if (exp.$absent === true) { if (act !== undefined) errors.push(`${path}: expected absent, got ${JSON.stringify(act)}`); return }
    if ('$length' in exp || '$first' in exp || '$last' in exp) {
      if (!Array.isArray(act)) { errors.push(`${path}: expected an array`); return }
      if ('$length' in exp && act.length !== exp.$length) errors.push(`${path}: length ${act.length} != ${exp.$length}`)
      if ('$first' in exp) subset(exp.$first, act[0], `${path}[0]`, errors)
      if ('$last' in exp) subset(exp.$last, act[act.length - 1], `${path}[-1]`, errors)
      return
    }
    if (act === null || typeof act !== 'object' || Array.isArray(act)) { errors.push(`${path}: expected object, got ${JSON.stringify(act)}`); return }
    for (const k of Object.keys(exp)) subset(exp[k], act[k], `${path}.${k}`, errors)
    return
  }
  if (Array.isArray(exp)) {
    if (!Array.isArray(act)) { errors.push(`${path}: expected array, got ${JSON.stringify(act)}`); return }
    if (act.length !== exp.length) { errors.push(`${path}: array length ${act.length} != ${exp.length}`); return }
    exp.forEach((e, i) => subset(e, act[i], `${path}[${i}]`, errors))
    return
  }
  if (JSON.stringify(exp) !== JSON.stringify(act)) errors.push(`${path}: expected ${JSON.stringify(exp)}, got ${JSON.stringify(act)}`)
}

function checkAgainstFixture(fixture, out, label) {
  const errors = []
  if (fixture.expected) subset(fixture.expected, { steps: out.steps, final: out.final }, label, errors)
  const blob = JSON.stringify({ steps: out.steps, final: out.final })
  for (const s of fixture.mustNotContain ?? []) if (blob.includes(s)) errors.push(`${label}: output contains forbidden string ${JSON.stringify(s)}`)
  return errors
}

function runTs(file) {
  return JSON.parse(execFileSync('npx', ['tsx', join(__dirname, 'run-ts-memory.mts'), join(fixturesDir, file)], { cwd: __dirname, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }))
}
function runPy(file) {
  return JSON.parse(execFileSync('python3.12', [join(__dirname, 'run_py_memory.py'), join(fixturesDir, file)], { cwd: __dirname, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }))
}

const fixtureFiles = readdirSync(fixturesDir).filter((f) => f.endsWith('.json')).sort()
let untracked = 0
let tracked = 0
let passes = 0

for (const file of fixtureFiles) {
  const id = file.replace(/\.json$/, '')
  const fixture = JSON.parse(readFileSync(join(fixturesDir, file), 'utf-8'))
  const problems = []
  let tsOut
  let pyOut
  try { tsOut = runTs(file) } catch (e) { problems.push(`ts runner failed: ${String(e.stderr || e.message).split('\n').slice(0, 6).join(' | ')}`) }
  if (tsOut) problems.push(...checkAgainstFixture(fixture, tsOut, 'ts'))
  if (!tsOnly) {
    try { pyOut = runPy(file) } catch (e) { problems.push(`py runner failed: ${String(e.stderr || e.message).split('\n').slice(-6).join(' | ')}`) }
    if (pyOut) problems.push(...checkAgainstFixture(fixture, pyOut, 'py'))
    if (tsOut && pyOut) {
      const a = JSON.stringify(canonical({ steps: tsOut.steps, final: tsOut.final }))
      const b = JSON.stringify(canonical({ steps: pyOut.steps, final: pyOut.final }))
      if (a !== b) problems.push(`ts != py\n  ts: ${a}\n  py: ${b}`)
    }
  }

  if (problems.length === 0) {
    if (knownDiscrepancies[id]) console.log(`PASS  ${id}  (listed in known-discrepancies-memory.json but now matches: remove the entry)`)
    else console.log(`PASS  ${id}`)
    passes++
  } else if (knownDiscrepancies[id]) {
    console.log(`DISCREPANCY (tracked)  ${id}`)
    console.log(`  reason: ${knownDiscrepancies[id]}`)
    for (const p of problems) console.log(`  ${p}`)
    tracked++
  } else {
    console.log(`MISMATCH (untracked!)  ${id}`)
    for (const p of problems) console.log(`  ${p}`)
    untracked++
  }
}

console.log(`\n${passes} pass, ${tracked} tracked, ${untracked} untracked (${fixtureFiles.length} fixtures${tsOnly ? ', ts-only' : ''})`)
process.exit(untracked > 0 ? 1 : 0)
