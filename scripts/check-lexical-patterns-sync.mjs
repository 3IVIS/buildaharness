#!/usr/bin/env node
/**
 * Verifies the lexical pattern JSON files that exist as two independent copies (one per
 * language/runtime that can't import the other's module graph at runtime) stay byte-identical —
 * mirrors scripts/check-plan-templates-sync.mjs's exact approach (sorted-key JSON comparison,
 * not a raw byte diff, so key reordering alone doesn't false-positive).
 *
 * Most lexical pattern JSON (packages/personal-assistant/src/lexical/patterns/*.json other than
 * template-keywords.json) has only ONE copy — TypeScript's own canonical source, read directly by
 * file-tools-mcp-server.mjs (a plain JSON read, no import barrier) — so there's nothing to check
 * for those; this script only covers the two pairs that genuinely have independent copies:
 *
 *   packages/harness/src/lexical/patterns/negation.json
 *     <-> adapter/harness/lexical_patterns/negation.json
 *   packages/personal-assistant/src/lexical/patterns/template-keywords.json
 *     <-> adapter/agents/planner/lexical_patterns/template-keywords.json
 *
 * Run manually:  node scripts/check-lexical-patterns-sync.mjs
 * Run in CI:     same command; exits 1 on mismatch.
 */
import { readFileSync } from 'fs'

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeysDeep(value[k])]))
  }
  return value
}

function loadJson(path) {
  return JSON.stringify(sortKeysDeep(JSON.parse(readFileSync(path, 'utf8'))))
}

const PAIRS = [
  {
    name: 'negation.json (harness-core)',
    a: 'packages/harness/src/lexical/patterns/negation.json',
    b: 'adapter/harness/lexical_patterns/negation.json',
  },
  {
    name: 'template-keywords.json (plan-templates)',
    a: 'packages/personal-assistant/src/lexical/patterns/template-keywords.json',
    b: 'adapter/agents/planner/lexical_patterns/template-keywords.json',
  },
]

const mismatched = []
for (const { name, a, b } of PAIRS) {
  if (loadJson(a) !== loadJson(b)) mismatched.push({ name, a, b })
}

if (mismatched.length > 0) {
  console.error('❌  These lexical pattern files have drifted from their mirrored copy:')
  for (const { name, a, b } of mismatched) {
    console.error(`     - ${name}: ${a} != ${b}`)
  }
  console.error('\nCopy the updated file over its counterpart, then re-run.')
  process.exit(1)
}

console.log(`✅  Lexical patterns sync OK — ${PAIRS.length} mirrored pair(s) match byte-for-byte (ignoring key order).`)
