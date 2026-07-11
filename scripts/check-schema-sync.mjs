#!/usr/bin/env node
/**
 * Fix #35: verifies that src/spec/schema.ts exports the same public type and
 * const names as the canonical spec/schema.ts.
 *
 * This does NOT enforce line-for-line equality (the canvas copy intentionally
 * omits .refine() calls). It enforces that every export from the canonical
 * schema is present in the canvas copy, so divergence is caught in CI.
 *
 * It also checks packages/runtime/src/spec/schema.ts against
 * packages/canvas/src/spec/schema.ts — not against the canonical schema,
 * because both of those copies are deliberately scoped to v0.2.0 (they predate
 * the v1.0.0 harness node types, which live only in src/spec/schema.ts) and
 * checking runtime's copy against canonical would flag that pre-existing,
 * intentional gap as new drift. What actually matters for runtime is staying
 * in sync with canvas's copy specifically, since runtime's copy was forked
 * from it (see packages/runtime/src/spec/schema.ts's header comment) — a
 * known, small set of canvas's UI-only exports are allowed to be absent from
 * runtime's copy (CANVAS_ONLY_EXTRAS below); anything else missing is drift.
 *
 * Run manually:  node scripts/check-schema-sync.mjs
 * Run in CI:     same command; exits 1 on mismatch.
 */
import { readFileSync } from 'fs'

function extractExports(src) {
  const names = new Set()
  // Match: export const Foo, export type Foo, export function Foo, export interface Foo
  const re = /^export\s+(?:const|type|function|interface|enum|class)\s+([A-Za-z_]\w*)/gm
  let m
  while ((m = re.exec(src)) !== null) names.add(m[1])
  return names
}

function checkSync(fromLabel, fromExports, toLabel, toExports, { allowedMissing = new Set() } = {}) {
  const missing = [...fromExports].filter((name) => !toExports.has(name) && !allowedMissing.has(name))
  if (missing.length > 0) {
    console.error(`❌  ${toLabel} is missing exports that exist in ${fromLabel}:`)
    missing.forEach((name) => console.error(`     - ${name}`))
    return false
  }

  const extras = [...toExports].filter((name) => !fromExports.has(name))
  if (extras.length > 0) {
    console.warn(`ℹ️   ${toLabel}-only exports (not in ${fromLabel} — this is OK):`)
    extras.forEach((name) => console.warn(`     + ${name}`))
  }

  console.log(`✅  ${toLabel} sync OK vs ${fromLabel} — ${fromExports.size - allowedMissing.size} required exports present.`)
  return true
}

const canonical = readFileSync('spec/schema.ts', 'utf8')
const canvasApp  = readFileSync('src/spec/schema.ts', 'utf8')
const canvasPkg  = readFileSync('packages/canvas/src/spec/schema.ts', 'utf8')
const runtimePkg = readFileSync('packages/runtime/src/spec/schema.ts', 'utf8')

const canonicalExports = extractExports(canonical)
const canvasAppExports  = extractExports(canvasApp)
const canvasPkgExports  = extractExports(canvasPkg)
const runtimeExports    = extractExports(runtimePkg)

// packages/canvas/src/spec/schema.ts's UI-only additions (palette/icon labels,
// support-matrix, lenient-parse migration helper) that packages/runtime/src/spec/schema.ts
// deliberately doesn't need — see that file's header comment.
const CANVAS_ONLY_EXTRAS = new Set([
  'ADAPTER_LABELS',
  'AnyNode',
  'AnyNodeType',
  'CURRENT_SPEC_VERSION',
  'HarnessNodeType',
  'NODE_SUPPORT_MATRIX',
  'parseFlowSpecLenient',
])

let ok = true
ok = checkSync('spec/schema.ts', canonicalExports, 'src/spec/schema.ts', canvasAppExports) && ok
ok = checkSync('packages/canvas/src/spec/schema.ts', canvasPkgExports, 'packages/runtime/src/spec/schema.ts', runtimeExports, { allowedMissing: CANVAS_ONLY_EXTRAS }) && ok

if (!ok) {
  console.error('\nSync the schema copies, then re-run.')
  process.exit(1)
}
