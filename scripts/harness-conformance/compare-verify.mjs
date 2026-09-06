#!/usr/bin/env node
// Standalone TS-vs-Python conformance runner for verify() / verify.ts — the
// 9-layer verification-layer runner. The companion to compare.mjs (which covers
// resolveControlState()).
//
// Usage: node scripts/harness-conformance/compare-verify.mjs
//
// For each fixtures-verify/*.json, runs both languages' own verify() on the same
// logical input and diffs a STATUS PROJECTION of the resulting VerificationResult:
// per-layer status, has_critical_failure, adversarial_passed, critical_failure_tiers.
// The `detail` prose is deliberately excluded — see README.md's VERIFY-EQUIVALENCE
// CONTRACT for why (it is per-implementation human-facing text; the plan's scope for
// this pair is "each layer's PASS / FAIL / SKIPPED and has_critical_failure").
//
// A fixture listed in known-discrepancies-verify.json is reported as a tracked
// discrepancy (exit 0); any other mismatch is an untracked regression (exit 1).
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, 'fixtures-verify')
const knownDiscrepancies = JSON.parse(
  readFileSync(join(__dirname, 'known-discrepancies-verify.json'), 'utf-8'),
)

const fixtureFiles = readdirSync(fixturesDir).filter((f) => f.endsWith('.json')).sort()

let untrackedMismatches = 0
let trackedMismatches = 0
let passes = 0

for (const file of fixtureFiles) {
  const id = file.replace(/\.json$/, '')
  const tsOut = JSON.parse(
    execFileSync('npx', ['tsx', join(__dirname, 'run-ts-verify.mts'), join('fixtures-verify', file)], {
      cwd: __dirname,
      encoding: 'utf-8',
    }),
  )
  const pyOut = JSON.parse(
    execFileSync('python3.12', [join(__dirname, 'run_py_verify.py'), join('fixtures-verify', file)], {
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
  console.error(
    '\nFAIL: untracked TS/Python divergence in verify() — either fix it or add it to known-discrepancies-verify.json with a reason.',
  )
  process.exit(1)
}
