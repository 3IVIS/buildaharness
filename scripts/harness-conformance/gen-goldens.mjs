#!/usr/bin/env node
// Golden generator / checker for the INV-13 in-suite conformance gate
// (ADR-004, shared semantic core).
//
//   node scripts/harness-conformance/gen-goldens.mjs            # --check (default)
//   node scripts/harness-conformance/gen-goldens.mjs --write    # (re)write goldens/<id>.json
//
// For every fixtures/*.json this runs the PYTHON resolver (run_py.py) and treats its
// serialized ControlState as the canonical expected output — the two runtimes are already
// proven byte-equal for every committed fixture by compare.mjs, so the Python output is a
// valid golden for BOTH the pytest gate (adapter/tests/test_harness_conformance_gate.py)
// and the vitest gate (packages/harness/src/nodes/conformance-gate.test.ts).
//
// IMPORTANT: goldens encode resolver BEHAVIOUR. Only regenerate them (`--write`) when the
// resolver algorithm legitimately changed AND `node scripts/harness-conformance/compare.mjs`
// still reports every fixture PASS (0 untracked) — i.e. both runtimes were updated in
// lockstep. A `--write` that is not backed by a green compare.mjs run is exactly the
// one-side drift INV-13 exists to catch.
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, 'fixtures')
const goldensDir = join(__dirname, 'goldens')

const write = process.argv.includes('--write')
if (write && !existsSync(goldensDir)) mkdirSync(goldensDir, { recursive: true })

const fixtureFiles = readdirSync(fixturesDir).filter(f => f.endsWith('.json')).sort()

// Canonical serialisation: parse the Python resolver's JSON, then re-emit it via JS with
// 2-space indent + a trailing newline. Parsing-then-reserialising normalises JSON number
// formatting (1.0 -> 1) the exact same way compare.mjs already does, so a byte compare of
// this form is meaningful on both sides.
function canonical(jsonText) {
  return JSON.stringify(JSON.parse(jsonText), null, 2) + '\n'
}

let mismatches = 0
let wrote = 0
for (const file of fixtureFiles) {
  const id = file.replace(/\.json$/, '')
  const pyOut = execFileSync('python3.12', [join(__dirname, 'run_py.py'), join('fixtures', file)], {
    cwd: __dirname,
    encoding: 'utf-8',
  })
  const golden = canonical(pyOut)
  const goldenPath = join(goldensDir, `${id}.json`)

  if (write) {
    const existing = existsSync(goldenPath) ? readFileSync(goldenPath, 'utf-8') : null
    if (existing !== golden) {
      writeFileSync(goldenPath, golden)
      console.log(`WROTE  ${id}`)
      wrote++
    } else {
      console.log(`ok     ${id}`)
    }
  } else {
    if (!existsSync(goldenPath)) {
      console.log(`MISSING  ${id}  (run with --write)`)
      mismatches++
      continue
    }
    const existing = readFileSync(goldenPath, 'utf-8')
    if (existing !== golden) {
      console.log(`STALE    ${id}  (golden differs from current Python resolver output)`)
      mismatches++
    } else {
      console.log(`PASS     ${id}`)
    }
  }
}

// flag any orphan goldens with no matching fixture
const fixtureIds = new Set(fixtureFiles.map(f => f.replace(/\.json$/, '')))
for (const g of (existsSync(goldensDir) ? readdirSync(goldensDir) : [])) {
  if (!g.endsWith('.json')) continue
  const id = g.replace(/\.json$/, '')
  if (!fixtureIds.has(id)) {
    console.log(`ORPHAN   ${id}  (golden with no fixture)`)
    mismatches++
  }
}

if (write) {
  console.log(`\n${wrote} golden(s) written, ${fixtureFiles.length} fixtures total`)
} else {
  console.log(`\n${fixtureFiles.length - mismatches}/${fixtureFiles.length} goldens current`)
  if (mismatches > 0) {
    console.error(
      '\nFAIL: goldens are stale or missing. If the resolver legitimately changed and ' +
        'compare.mjs is green, run: node scripts/harness-conformance/gen-goldens.mjs --write',
    )
    process.exit(1)
  }
}
