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

// Fix (Phase 1): the export-name check above can't catch a version-literal
// drift (spec_version pinned to an old value) or a node-type drift (a node
// type existing in one copy's discriminated union but not another's) — both
// slipped through undetected. These two checks close that gap.

function extractVersionLiteral(src, constName) {
  const m = src.match(new RegExp(`export const ${constName}\\s*=\\s*(.+)`))
  return m ? m[1].trim().replace(/\s*as const$/, '') : null
}

function extractNodeTypeLiterals(src) {
  const names = new Set()
  const re = /type:\s*z\.literal\('([^']+)'\)/g
  let m
  while ((m = re.exec(src)) !== null) names.add(m[1])
  return names
}

function checkVersionLiteral(label, value, referenceLabel, referenceValue) {
  if (value === null) return true // constant not exported here — fine, checked elsewhere via export-name parity
  if (referenceValue !== null && value !== referenceValue) {
    console.error(`❌  ${label}'s literal (${value}) does not match ${referenceLabel}'s (${referenceValue})`)
    return false
  }
  return true
}

function checkNodeTypeSync(fromLabel, fromTypes, toLabel, toTypes, { allowedMissing = new Set() } = {}) {
  const missing = [...fromTypes].filter((t) => !toTypes.has(t) && !allowedMissing.has(t))
  if (missing.length > 0) {
    console.error(`❌  ${toLabel} is missing node types that exist in ${fromLabel}:`)
    missing.forEach((t) => console.error(`     - ${t}`))
    return false
  }
  console.log(`✅  ${toLabel} node-type parity OK vs ${fromLabel}.`)
  return true
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

// Node types that exist in the canonical/main-app copies but are deliberately
// absent from the canvas-package/runtime-package copies' strict discriminated
// union — those two copies validate harness nodes via RuntimeFlowSpec's
// passthrough stub instead of typing each one (see packages/canvas/src/spec/
// schema.ts's HarnessNodeType comment).
const HARNESS_NODE_TYPES = new Set([
  'world_model', 'hypothesis_set', 'gather_evidence', 'apply_tool_reliability',
  'update_world_model', 'control_state', 'task_graph_node', 'verification_gate',
  'recovery_node', 'evidence_store_node', 'experience_store_node', 'reviewer_pass',
  'process_concept',
])

const canonicalVersion = extractVersionLiteral(canonical, 'SpecVersion')
const canvasAppVersion  = extractVersionLiteral(canvasApp, 'SpecVersion')
const canvasPkgVersion  = extractVersionLiteral(canvasPkg, 'SpecVersion')
const runtimeVersion    = extractVersionLiteral(runtimePkg, 'SpecVersion')
const canvasAppCurrent  = extractVersionLiteral(canvasApp, 'CURRENT_SPEC_VERSION')
const canvasPkgCurrent  = extractVersionLiteral(canvasPkg, 'CURRENT_SPEC_VERSION')

let ok = true
ok = checkSync('spec/schema.ts', canonicalExports, 'src/spec/schema.ts', canvasAppExports) && ok
ok = checkSync('packages/canvas/src/spec/schema.ts', canvasPkgExports, 'packages/runtime/src/spec/schema.ts', runtimeExports, { allowedMissing: CANVAS_ONLY_EXTRAS }) && ok

// SpecVersion must be byte-identical across all four copies — this is what
// missed the packages/canvas v0.2.0 pin (Phase 1).
ok = checkVersionLiteral('src/spec/schema.ts SpecVersion', canvasAppVersion, 'spec/schema.ts SpecVersion', canonicalVersion) && ok
ok = checkVersionLiteral('packages/canvas SpecVersion', canvasPkgVersion, 'spec/schema.ts SpecVersion', canonicalVersion) && ok
ok = checkVersionLiteral('packages/runtime SpecVersion', runtimeVersion, 'spec/schema.ts SpecVersion', canonicalVersion) && ok
ok = checkVersionLiteral('packages/canvas CURRENT_SPEC_VERSION', canvasPkgCurrent, 'src/spec/schema.ts CURRENT_SPEC_VERSION', canvasAppCurrent) && ok

// Node-type literal parity: canonical vs src/spec/schema.ts must match exactly;
// canvas/runtime are allowed to lack the harness-only node types by design.
const canonicalNodeTypes = extractNodeTypeLiterals(canonical)
const canvasAppNodeTypes = extractNodeTypeLiterals(canvasApp)
const canvasPkgNodeTypes = extractNodeTypeLiterals(canvasPkg)
const runtimeNodeTypes   = extractNodeTypeLiterals(runtimePkg)
ok = checkNodeTypeSync('spec/schema.ts', canonicalNodeTypes, 'src/spec/schema.ts', canvasAppNodeTypes) && ok
ok = checkNodeTypeSync('src/spec/schema.ts', canvasAppNodeTypes, 'spec/schema.ts', canonicalNodeTypes) && ok
ok = checkNodeTypeSync('packages/canvas/src/spec/schema.ts', canvasPkgNodeTypes, 'packages/runtime/src/spec/schema.ts', runtimeNodeTypes) && ok
ok = checkNodeTypeSync('src/spec/schema.ts', canvasAppNodeTypes, 'packages/canvas/src/spec/schema.ts', canvasPkgNodeTypes, { allowedMissing: HARNESS_NODE_TYPES }) && ok

if (!ok) {
  console.error('\nSync the schema copies, then re-run.')
  process.exit(1)
}
