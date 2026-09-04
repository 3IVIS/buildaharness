#!/usr/bin/env node
/**
 * Phase C1 (plans/harness_consolidation_and_control_plane_plan.html; docs/adr/004-shared-semantic-core.md).
 *
 * Generates the harness's pure-data decision constants into BOTH runtimes from
 * one canonical source, spec/harness-core.json:
 *
 *   spec/harness-core.json  ──►  adapter/harness/_core_generated.py
 *                           ──►  packages/harness/src/_core-generated.ts
 *
 * The constants (CRITICAL/CAUTION thresholds, RECOVERY_ACTION_DEPENDENCIES,
 * DIMENSION_RECOVERY, the risk/confidence dimension pools, the sub-dimension
 * order, LAYER_TIER, the dep_class_gap note prefix) were hand-mirrored in
 * control_state.py / resolve-control-state.ts / verification.py / verify.ts and
 * guarded by scripts/check-harness-constants-sync.mjs (now retired). Generation
 * makes that drift structurally impossible.
 *
 * The generated files are committed (like the four schema copies) — harness
 * source is not volume-mounted, and `docker cp adapter/harness/.` only syncs
 * that tree, so nothing may be read cross-tree at runtime.
 *
 * Usage:
 *   node spec/gen-harness-core.mjs            # regenerate both files
 *   node spec/gen-harness-core.mjs --check    # CI mode: exit 1 if either is stale
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CHECK = process.argv.includes('--check')
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const SOURCE = join(repoRoot, 'spec/harness-core.json')
const PY_OUT = join(repoRoot, 'adapter/harness/_core_generated.py')
const TS_OUT = join(repoRoot, 'packages/harness/src/_core-generated.ts')

const core = JSON.parse(readFileSync(SOURCE, 'utf8'))

// Strip the human-facing "_README" keys before emitting code.
function stripReadme(value) {
  if (Array.isArray(value)) return value.map(stripReadme)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => k !== '_README')
        .map(([k, v]) => [k, stripReadme(v)]),
    )
  }
  return value
}

const {
  thresholds,
  recovery_action_dependencies: recoveryDeps,
  dimension_recovery: dimensionRecovery,
  sub_dimension_order: subDimensionOrder,
  confidence_dimensions: confidenceDimensions,
  risk_dimensions: riskDimensions,
  layer_tier: layerTier,
  dep_class_gap_note_prefix: depClassGapNotePrefix,
} = stripReadme(core)

const GEN_HEADER_LINES = [
  'DO NOT EDIT — generated from spec/harness-core.json by spec/gen-harness-core.mjs.',
  'Run `node spec/gen-harness-core.mjs` after editing the source. CI fails if this file is stale.',
  'See docs/adr/004-shared-semantic-core.md (Phase C1).',
]

// ── Python ───────────────────────────────────────────────────────────────────

function pyStr(s) {
  return JSON.stringify(s)
}

function pyList(items) {
  return '[' + items.map(pyStr).join(', ') + ']'
}

function pySetLiteral(items) {
  return '{' + items.map(pyStr).join(', ') + '}'
}

// Emit `NAME: frozenset[str] = frozenset(\n    {...}\n)` — the shape `ruff format`
// produces for a frozenset literal that does not fit on one line under line-length 120.
function pyFrozenset(name, items) {
  return [
    `${name}: frozenset[str] = frozenset(`,
    `    ${pySetLiteral(items)}`,
    ')',
  ]
}

function renderPy() {
  const lines = []
  lines.push('"""')
  for (const l of GEN_HEADER_LINES) lines.push(l)
  lines.push('"""')
  lines.push('')
  lines.push('from __future__ import annotations')
  lines.push('')
  lines.push(`CRITICAL_THRESHOLD: float = ${thresholds.critical}`)
  lines.push(`CAUTION_THRESHOLD: float = ${thresholds.caution}`)
  lines.push('')
  lines.push('RECOVERY_ACTION_DEPENDENCIES: dict[str, set[str]] = {')
  for (const [k, v] of Object.entries(recoveryDeps)) {
    lines.push(`    ${pyStr(k)}: ${pySetLiteral(v)},`)
  }
  lines.push('}')
  lines.push('')
  lines.push('DIMENSION_RECOVERY: dict[str, str] = {')
  for (const [k, v] of Object.entries(dimensionRecovery)) {
    lines.push(`    ${pyStr(k)}: ${pyStr(v)},`)
  }
  lines.push('}')
  lines.push('')
  lines.push('SUB_DIMENSION_ORDER: tuple[str, ...] = (')
  for (const name of subDimensionOrder) {
    lines.push(`    ${pyStr(name)},`)
  }
  lines.push(')')
  lines.push('')
  lines.push(...pyFrozenset('CONFIDENCE_DIMENSIONS', confidenceDimensions))
  lines.push(...pyFrozenset('RISK_DIMENSIONS', riskDimensions))
  lines.push('')
  lines.push('LAYER_TIER: dict[str, str] = {')
  for (const [k, v] of Object.entries(layerTier)) {
    lines.push(`    ${pyStr(k)}: ${pyStr(v)},`)
  }
  lines.push('}')
  lines.push('')
  lines.push(`DEP_CLASS_GAP_NOTE_PREFIX: str = ${pyStr(depClassGapNotePrefix)}`)
  lines.push('')
  return lines.join('\n')
}

// ── TypeScript ───────────────────────────────────────────────────────────────

function tsStr(s) {
  return JSON.stringify(s)
}

function renderTs() {
  const lines = []
  lines.push('/*')
  for (const l of GEN_HEADER_LINES) lines.push(` * ${l}`)
  lines.push(' */')
  lines.push('')
  lines.push(`export const CRITICAL_THRESHOLD = ${thresholds.critical}`)
  lines.push(`export const CAUTION_THRESHOLD = ${thresholds.caution}`)
  lines.push('')
  lines.push('export const RECOVERY_ACTION_DEPENDENCIES: Record<string, string[]> = {')
  for (const [k, v] of Object.entries(recoveryDeps)) {
    lines.push(`  ${tsStr(k)}: [${v.map(tsStr).join(', ')}],`)
  }
  lines.push('}')
  lines.push('')
  lines.push('export const DIMENSION_RECOVERY: Record<string, string> = {')
  for (const [k, v] of Object.entries(dimensionRecovery)) {
    lines.push(`  ${tsStr(k)}: ${tsStr(v)},`)
  }
  lines.push('}')
  lines.push('')
  lines.push(`export const SUB_DIMENSION_ORDER: readonly string[] = [${subDimensionOrder.map(tsStr).join(', ')}]`)
  lines.push('')
  lines.push(`export const CONFIDENCE_DIMENSIONS: ReadonlySet<string> = new Set([${confidenceDimensions.map(tsStr).join(', ')}])`)
  lines.push(`export const RISK_DIMENSIONS: ReadonlySet<string> = new Set([${riskDimensions.map(tsStr).join(', ')}])`)
  lines.push('')
  lines.push("export type LayerTier = 'mechanical' | 'environmental' | 'model'")
  lines.push('export const LAYER_TIER: Record<string, LayerTier> = {')
  for (const [k, v] of Object.entries(layerTier)) {
    lines.push(`  ${tsStr(k)}: ${tsStr(v)},`)
  }
  lines.push('}')
  lines.push('')
  lines.push(`export const DEP_CLASS_GAP_NOTE_PREFIX = ${tsStr(depClassGapNotePrefix)}`)
  lines.push('')
  return lines.join('\n')
}

// ── Emit / check ─────────────────────────────────────────────────────────────

const targets = [
  { path: PY_OUT, content: renderPy(), label: 'adapter/harness/_core_generated.py' },
  { path: TS_OUT, content: renderTs(), label: 'packages/harness/src/_core-generated.ts' },
]

let stale = false
for (const { path, content, label } of targets) {
  if (CHECK) {
    let existing = ''
    try {
      existing = readFileSync(path, 'utf8')
    } catch {
      existing = ''
    }
    if (existing !== content) {
      console.error(`❌  ${label} is out of date. Run: node spec/gen-harness-core.mjs`)
      stale = true
    } else {
      console.log(`✅  ${label} is up to date.`)
    }
  } else {
    writeFileSync(path, content, 'utf8')
    console.log(`wrote ${label}`)
  }
}

if (CHECK && stale) process.exit(1)
