#!/usr/bin/env node
// Standalone TS-vs-Python conformance runner for the generic ask-question mechanism
// (Q8 of the internal plan) — the companion to compare.mjs
// (resolveControlState), compare-verify.mjs (verify), and compare-supervisor.mjs
// (Trajectory Supervisor).
//
// Usage: node scripts/harness-conformance/compare-ask-question.mjs
//
// For each fixtures-ask-question/*.json, feeds the fixture's `op` + inputs through
// adapter/harness/{ask_question,escalation}.py and
// packages/harness/src/{ask-question,nodes/escalate}.ts and diffs the normalised
// output (keys deep-sorted first, so field-declaration order is not part of the
// contract). Covers the deterministic parts only — schema validation, degradation
// rules, INV-26/27/28/29/34/37 — never the LLM-authored question text itself, same
// carve-out compare-supervisor.mjs makes.
//
// A fixture in known-discrepancies-ask-question.json is a tracked discrepancy
// (exit 0); any other mismatch is an untracked regression (exit 1).
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, 'fixtures-ask-question')
const knownDiscrepancies = JSON.parse(
  readFileSync(join(__dirname, 'known-discrepancies-ask-question.json'), 'utf-8'),
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
    execFileSync(
      'npx',
      ['tsx', join(__dirname, 'run-ts-ask-question.mts'), join('fixtures-ask-question', file)],
      { cwd: __dirname, encoding: 'utf-8' },
    ),
  )
  const pyOut = JSON.parse(
    execFileSync('python3.12', [join(__dirname, 'run_py_ask_question.py'), join('fixtures-ask-question', file)], {
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
