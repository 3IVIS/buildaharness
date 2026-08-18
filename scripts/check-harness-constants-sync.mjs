#!/usr/bin/env node
/**
 * Phase 3 completion (plans/harness_and_assistant_architecture_remediation_plan.html):
 * verifies that the hand-duplicated control-state constants in
 * adapter/harness/control_state.py stay in sync with their TS ports in
 * packages/harness/src/nodes/resolve-control-state.ts, plus the third,
 * function-scoped CAUTION_THRESHOLD copy in packages/harness/src/generation-id.ts.
 *
 * Modeled on scripts/check-schema-sync.mjs: regex-extraction + set/value
 * comparison, no AST/compiler API, plain `node` invocation.
 *
 * Checks:
 *  - CRITICAL_THRESHOLD / CAUTION_THRESHOLD numeric literals (control_state.py
 *    vs resolve-control-state.ts, and resolve-control-state.ts vs the
 *    generation-id.ts CAUTION_THRESHOLD copy)
 *  - RECOVERY_ACTION_DEPENDENCIES map keys + values
 *  - _DIMENSION_RECOVERY / DIMENSION_RECOVERY map keys + values
 *
 * Run manually:  node scripts/check-harness-constants-sync.mjs
 * Run in CI:     same command; exits 1 on mismatch.
 */
import { readFileSync } from 'fs'

const CONTROL_STATE_PY = 'adapter/harness/control_state.py'
const RESOLVE_CONTROL_STATE_TS = 'packages/harness/src/nodes/resolve-control-state.ts'
const GENERATION_ID_TS = 'packages/harness/src/generation-id.ts'

function extractNumberConst(src, name) {
  // Matches both `NAME: float = 0.2` (Python) and `export const NAME = 0.2` (TS)
  const m = src.match(new RegExp(`\\b${name}\\b[^=]*=\\s*([0-9.]+)`))
  if (!m) return null
  return Number(m[1])
}

// Extracts a Python dict-of-set literal:
//   NAME: dict[str, set[str]] = {
//     "key": {"a", "b"},  # comment
//     ...
//   }
function extractPyDictOfSets(src, name) {
  const start = src.indexOf(`${name}:`)
  if (start === -1) return null
  const braceStart = src.indexOf('{', start)
  const braceEnd = findMatchingBrace(src, braceStart)
  const body = src.slice(braceStart + 1, braceEnd)
  const entries = {}
  const entryRe = /"([^"]+)"\s*:\s*\{([^}]*)\}/g
  let m
  while ((m = entryRe.exec(body)) !== null) {
    const key = m[1]
    const values = [...m[2].matchAll(/"([^"]+)"/g)].map((v) => v[1]).sort()
    entries[key] = values
  }
  return entries
}

// Extracts a Python dict-of-strings literal:
//   NAME: dict[str, str] = {
//     "key": "value",  # comment
//     ...
//   }
function extractPyDictOfStrings(src, name) {
  const start = src.indexOf(`${name}:`)
  if (start === -1) return null
  const braceStart = src.indexOf('{', start)
  const braceEnd = findMatchingBrace(src, braceStart)
  const body = src.slice(braceStart + 1, braceEnd)
  const entries = {}
  const entryRe = /"([^"]+)"\s*:\s*"([^"]+)"/g
  let m
  while ((m = entryRe.exec(body)) !== null) entries[m[1]] = m[2]
  return entries
}

// Extracts a TS Record<string, string[]> literal:
//   export const NAME: Record<string, string[]> = {
//     key: ['a', 'b'],
//     ...
//   }
function extractTsRecordOfArrays(src, name) {
  const start = src.indexOf(`${name}:`)
  if (start === -1) return null
  const braceStart = src.indexOf('{', start)
  const braceEnd = findMatchingBrace(src, braceStart)
  const body = src.slice(braceStart + 1, braceEnd)
  const entries = {}
  const entryRe = /(\w+):\s*\[([^\]]*)\]/g
  let m
  while ((m = entryRe.exec(body)) !== null) {
    const key = m[1]
    const values = [...m[2].matchAll(/'([^']+)'/g)].map((v) => v[1]).sort()
    entries[key] = values
  }
  return entries
}

// Extracts a TS Record<string, string> literal:
//   const NAME: Record<string, string> = {
//     key: 'value',
//     ...
//   }
function extractTsRecordOfStrings(src, name) {
  const start = src.indexOf(`${name}:`)
  if (start === -1) return null
  const braceStart = src.indexOf('{', start)
  const braceEnd = findMatchingBrace(src, braceStart)
  const body = src.slice(braceStart + 1, braceEnd)
  const entries = {}
  const entryRe = /(\w+):\s*'([^']+)'/g
  let m
  while ((m = entryRe.exec(body)) !== null) entries[m[1]] = m[2]
  return entries
}

function findMatchingBrace(src, openIdx) {
  let depth = 0
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  throw new Error(`unbalanced braces starting at index ${openIdx}`)
}

function checkNumber(label, pyValue, tsValue, tsLabel) {
  if (pyValue === null || tsValue === null) {
    console.error(`❌  could not extract ${label} from one of the sources`)
    return false
  }
  if (pyValue !== tsValue) {
    console.error(`❌  ${label} mismatch: ${tsLabel ?? 'python'}=${pyValue} vs ts=${tsValue}`)
    return false
  }
  console.log(`✅  ${label} in sync (${pyValue})`)
  return true
}

function deepEqualEntries(a, b) {
  const aKeys = Object.keys(a).sort()
  const bKeys = Object.keys(b).sort()
  if (JSON.stringify(aKeys) !== JSON.stringify(bKeys)) return false
  for (const k of aKeys) {
    const av = a[k]
    const bv = b[k]
    if (Array.isArray(av) || Array.isArray(bv)) {
      if (JSON.stringify(av) !== JSON.stringify(bv)) return false
    } else if (av !== bv) {
      return false
    }
  }
  return true
}

function checkMap(label, pyMap, tsMap) {
  if (pyMap === null || tsMap === null) {
    console.error(`❌  could not extract ${label} from one of the sources`)
    return false
  }
  if (!deepEqualEntries(pyMap, tsMap)) {
    console.error(`❌  ${label} mismatch between Python and TS:`)
    console.error(`     python: ${JSON.stringify(pyMap)}`)
    console.error(`     ts:     ${JSON.stringify(tsMap)}`)
    return false
  }
  console.log(`✅  ${label} in sync (${Object.keys(pyMap).length} entries)`)
  return true
}

const controlStatePy = readFileSync(CONTROL_STATE_PY, 'utf8')
const resolveControlStateTs = readFileSync(RESOLVE_CONTROL_STATE_TS, 'utf8')
const generationIdTs = readFileSync(GENERATION_ID_TS, 'utf8')

let ok = true

// Thresholds
ok = checkNumber(
  'CRITICAL_THRESHOLD',
  extractNumberConst(controlStatePy, 'CRITICAL_THRESHOLD'),
  extractNumberConst(resolveControlStateTs, 'CRITICAL_THRESHOLD'),
) && ok
ok = checkNumber(
  'CAUTION_THRESHOLD (control_state.py vs resolve-control-state.ts)',
  extractNumberConst(controlStatePy, 'CAUTION_THRESHOLD'),
  extractNumberConst(resolveControlStateTs, 'CAUTION_THRESHOLD'),
) && ok
ok = checkNumber(
  'CAUTION_THRESHOLD (control_state.py vs generation-id.ts)',
  extractNumberConst(controlStatePy, 'CAUTION_THRESHOLD'),
  extractNumberConst(generationIdTs, 'CAUTION_THRESHOLD'),
  'generation-id.ts',
) && ok

// RECOVERY_ACTION_DEPENDENCIES
ok = checkMap(
  'RECOVERY_ACTION_DEPENDENCIES',
  extractPyDictOfSets(controlStatePy, 'RECOVERY_ACTION_DEPENDENCIES'),
  extractTsRecordOfArrays(resolveControlStateTs, 'RECOVERY_ACTION_DEPENDENCIES'),
) && ok

// _DIMENSION_RECOVERY / DIMENSION_RECOVERY
ok = checkMap(
  '_DIMENSION_RECOVERY / DIMENSION_RECOVERY',
  extractPyDictOfStrings(controlStatePy, '_DIMENSION_RECOVERY'),
  extractTsRecordOfStrings(resolveControlStateTs, 'DIMENSION_RECOVERY'),
) && ok

if (!ok) {
  console.error('\nSync the harness constants, then re-run.')
  process.exit(1)
}
