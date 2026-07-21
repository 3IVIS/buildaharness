#!/usr/bin/env node
// Standalone TS-vs-Python conformance runner for resolve_control_state() (T10).
// Usage: node scripts/harness-conformance/compare.mjs
// For each fixtures/*.json, runs both languages' own implementation on the
// same input and diffs the resulting ControlState JSON. A fixture listed in
// known-discrepancies.json is reported as a tracked discrepancy (exit 0);
// any other mismatch is an untracked regression (exit 1).
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, 'fixtures')
const knownDiscrepancies = JSON.parse(readFileSync(join(__dirname, 'known-discrepancies.json'), 'utf-8'))

const fixtureFiles = readdirSync(fixturesDir).filter(f => f.endsWith('.json')).sort()

let untrackedMismatches = 0
let trackedMismatches = 0
let passes = 0

for (const file of fixtureFiles) {
  const id = file.replace(/\.json$/, '')
  const tsOut = JSON.parse(
    execFileSync('npx', ['tsx', join(__dirname, 'run-ts.mts'), join('fixtures', file)], {
      cwd: __dirname,
      encoding: 'utf-8',
    }),
  )
  const pyOut = JSON.parse(
    execFileSync('python3.12', [join(__dirname, 'run_py.py'), join('fixtures', file)], {
      cwd: __dirname,
      encoding: 'utf-8',
    }),
  )

  const match = JSON.stringify(tsOut) === JSON.stringify(pyOut)

  if (match) {
    console.log(`PASS  ${id}`)
    passes++
  } else if (knownDiscrepancies[id]) {
    console.log(`DISCREPANCY (tracked)  ${id}`)
    console.log(`  reason: ${knownDiscrepancies[id]}`)
    console.log(`  ts: ${JSON.stringify(tsOut)}`)
    console.log(`  py: ${JSON.stringify(pyOut)}`)
    trackedMismatches++
  } else {
    console.log(`MISMATCH (untracked!)  ${id}`)
    console.log(`  ts: ${JSON.stringify(tsOut)}`)
    console.log(`  py: ${JSON.stringify(pyOut)}`)
    untrackedMismatches++
  }
}

console.log(
  `\n${passes} passed, ${trackedMismatches} tracked discrepancies, ${untrackedMismatches} untracked mismatches (of ${fixtureFiles.length} fixtures)`,
)

if (untrackedMismatches > 0) {
  console.error('\nFAIL: untracked TS/Python divergence found — either fix it or add it to known-discrepancies.json with a reason.')
  process.exit(1)
}
