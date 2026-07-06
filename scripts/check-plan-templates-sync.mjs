#!/usr/bin/env node
/**
 * Verifies that packages/personal-assistant/src/plan-templates/data/*.json are
 * byte-identical (as parsed JSON, ignoring key order) to the canonical templates
 * in adapter/agents/planner/data/plan_templates/ — the personal assistant's
 * structured-planning gate (see plans/personal_assistant_structured_planning_plan.html)
 * builds plans from a TS-native mirror of these so it never needs a running
 * Python service, but that mirror can silently drift if only one side is edited.
 *
 * Run manually:  node scripts/check-plan-templates-sync.mjs
 * Run in CI:     same command; exits 1 on mismatch.
 */
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const CANONICAL_DIR = 'adapter/agents/planner/data/plan_templates'
const MIRROR_DIR = 'packages/personal-assistant/src/plan-templates/data'

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeysDeep(value[k])]))
  }
  return value
}

function loadTemplate(dir, name) {
  const raw = readFileSync(join(dir, name), 'utf8')
  return JSON.stringify(sortKeysDeep(JSON.parse(raw)))
}

const canonicalNames = readdirSync(CANONICAL_DIR).filter((f) => f.endsWith('.json')).sort()
const mirrorNames = readdirSync(MIRROR_DIR).filter((f) => f.endsWith('.json')).sort()

const missing = canonicalNames.filter((name) => !mirrorNames.includes(name))
const extra = mirrorNames.filter((name) => !canonicalNames.includes(name))

if (missing.length > 0) {
  console.error('❌  Missing mirrored templates:')
  missing.forEach((name) => console.error(`     - ${name}`))
}
if (extra.length > 0) {
  console.error('❌  Mirror has templates not present in the canonical directory:')
  extra.forEach((name) => console.error(`     - ${name}`))
}
if (missing.length > 0 || extra.length > 0) {
  process.exit(1)
}

const mismatched = []
for (const name of canonicalNames) {
  const canonical = loadTemplate(CANONICAL_DIR, name)
  const mirror = loadTemplate(MIRROR_DIR, name)
  if (canonical !== mirror) mismatched.push(name)
}

if (mismatched.length > 0) {
  console.error('❌  These templates have drifted from the canonical Python originals:')
  mismatched.forEach((name) => console.error(`     - ${name}`))
  console.error(`\nCopy the updated file(s) from ${CANONICAL_DIR}/ into ${MIRROR_DIR}/, then re-run.`)
  process.exit(1)
}

console.log(`✅  Plan templates sync OK — ${canonicalNames.length} templates match byte-for-byte (ignoring key order).`)
