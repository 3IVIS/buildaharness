#!/usr/bin/env node
// Standalone TS-vs-Python conformance runner for the Trajectory Supervisor's
// serialisation + coercion contract (S0 of
// plans/harness_trajectory_supervisor_plan.html) — the companion to compare.mjs
// (resolveControlState) and compare-verify.mjs (verify).
//
// Usage: node scripts/harness-conformance/compare-supervisor.mjs
//
// For each fixtures-supervisor/*.json, feeds `directive_in` / `digest_in` through
// SupervisorDirective.from_dict()/fromJSON() and TrajectoryDigest.from_dict()/
// fromJSON() on both runtimes and diffs the normalised to_dict()/toJSON() output
// (keys deep-sorted first, so field-declaration order is not part of the contract).
// This pins the enum-safety + payload-shape + length-cap + clamp coercion rules as
// byte-identical across the twins.
//
// A fixture in known-discrepancies-supervisor.json is a tracked discrepancy
// (exit 0); any other mismatch is an untracked regression (exit 1).
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, 'fixtures-supervisor')
const knownDiscrepancies = JSON.parse(
  readFileSync(join(__dirname, 'known-discrepancies-supervisor.json'), 'utf-8'),
)

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    )
  }
  return value
}

const fixtureFiles = readdirSync(fixturesDir).filter((f) => f.endsWith('.json')).sort()

let untracked = 0
let tracked = 0
let passes = 0

for (const file of fixtureFiles) {
  const id = file.replace(/\.json$/, '')
  const tsOut = JSON.parse(
    execFileSync('npx', ['tsx', join(__dirname, 'run-ts-supervisor.mts'), join('fixtures-supervisor', file)], {
      cwd: __dirname,
      encoding: 'utf-8',
    }),
  )
  const pyOut = JSON.parse(
    execFileSync('python3.12', [join(__dirname, 'run_py_supervisor.py'), join('fixtures-supervisor', file)], {
      cwd: __dirname,
      encoding: 'utf-8',
    }),
  )

  const match = JSON.stringify(canonical(tsOut)) === JSON.stringify(canonical(pyOut))

  if (match) {
    console.log(`PASS  ${id}`)
    passes++
  } else if (knownDiscrepancies[id]) {
    console.log(`DISCREPANCY (tracked)  ${id}`)
    console.log(`  reason: ${knownDiscrepancies[id]}`)
    console.log(`  ts: ${JSON.stringify(tsOut)}`)
    console.log(`  py: ${JSON.stringify(pyOut)}`)
    tracked++
  } else {
    console.log(`MISMATCH (untracked!)  ${id}`)
    console.log(`  ts: ${JSON.stringify(tsOut)}`)
    console.log(`  py: ${JSON.stringify(pyOut)}`)
    untracked++
  }
}

console.log(`\n${passes} pass, ${tracked} tracked, ${untracked} untracked (${fixtureFiles.length} fixtures)`)
process.exit(untracked > 0 ? 1 : 0)
