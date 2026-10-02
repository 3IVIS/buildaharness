#!/usr/bin/env node
/**
 * Agent memory framework, phase M8 (shared contract).
 *
 * Generates the memory component's pure-data decision constants into BOTH runtimes from one
 * canonical source, spec/memory-core.json (same pattern as spec/gen-harness-core.mjs):
 *
 *   spec/memory-core.json  ──►  adapter/harness/agent_memory/_core_generated.py
 *                          ──►  packages/aielia/src/_memory-core-generated.ts
 *
 * Algorithms stay hand-mirrored in each runtime and are pinned by conformance fixtures; only
 * constants and decision tables are generated. Python object KEYS are snake_cased (values are
 * wire strings and never change).
 *
 * Usage:
 *   node spec/gen-memory-core.mjs            # regenerate both files
 *   node spec/gen-memory-core.mjs --check    # CI mode: exit 1 if either is stale
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CHECK = process.argv.includes('--check')
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(repoRoot, 'spec/memory-core.json')
const PY_OUT = join(repoRoot, 'adapter/harness/agent_memory/_core_generated.py')
const TS_OUT = join(repoRoot, 'packages/aielia/src/_memory-core-generated.ts')

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

const core = stripReadme(JSON.parse(readFileSync(SOURCE, 'utf8')))
const { enums, store_keys: sk, budget, tier_rules: tr, audit, gate, inv16 } = core

const storeKeys = Object.fromEntries(Object.entries(sk).map(([k, v]) => [k, v.key]))
const undoMessages = Object.fromEntries(audit.undo_rules.map((r) => [r.id, r.message]))
const undoPythonOnly = audit.undo_rules.filter((r) => r.python_only).map((r) => r.id)

// [name, tsType | null, pyType, value]
const EXPORTS = [
  ['MEMORY_CORE_VERSION', null, 'str', core.version],
  ['DEFAULT_MEMORY_BUDGET_CHARS', null, 'int', budget.default_chars],
  ['BUDGET_HEADER', null, 'str', budget.header],
  ['BUDGET_LINE_FORMAT', null, 'str', budget.line_format],
  ['UNCONFIRMED_SUFFIX', null, 'str', budget.unconfirmed_suffix],
  ['BUDGET_SEPARATOR_COST', null, 'int', budget.separator_cost],
  ['TIER_PRIORITY', null, 'dict[str, int]', budget.priority],
  ['SESSION_PRIORITY', null, 'int', budget.session_priority],
  ['LEGACY_FACT_CAP', null, 'dict[str, Any]', budget.legacy_fact_cap],
  ['FACT_ID_FORMAT', null, 'str', core.fact_identity.fact_id_format],
  ['AUDIT_LOG_KEEP', null, 'int', audit.keep],
  ['STORE_KEYS', null, 'dict[str, str]', storeKeys],
  ['FACT_FIELDS', null, 'list[dict[str, Any]]', core.fact_fields.fields],
  ['FACT_TRANSIENT_FIELDS', null, 'list[str]', core.fact_fields.transient_fields],
  ['PENDING_FACT_EXTRA_FIELDS', null, 'list[dict[str, Any]]', core.fact_fields.pending_fact_extra_fields],
  ['PENDING_FACT_DEFAULT_CATEGORY', null, 'str', core.fact_fields.pending_fact_category_default],
  ['FACT_SOURCES', null, 'list[str]', enums.fact_source],
  ['FACT_ORIGINS', null, 'list[str]', enums.fact_origin],
  ['DEFAULT_FACT_ORIGIN', null, 'str', enums.fact_origin_default],
  ['FACT_CONFIDENCES', null, 'list[str]', enums.fact_confidence],
  ['FACT_CATEGORIES', null, 'list[str]', enums.fact_category],
  ['MEMORY_TIERS', null, 'list[str]', enums.memory_tier],
  ['TIER_RULES', null, 'dict[str, dict[str, Any]]', tr.rules],
  ['TIER_RULE_ORDER', null, 'list[dict[str, Any]]', tr.rule_order],
  ['WRITE_MODES', null, 'list[str]', enums.write_mode],
  ['DEFAULT_WRITE_MODE', null, 'str', enums.write_mode_default],
  ['WRITERS', null, 'list[str]', enums.writer],
  ['WRITE_ROUTES', null, 'list[str]', enums.write_route],
  ['WRITE_ROUTE_TABLE', null, 'list[dict[str, Any]]', core.write_route.rows],
  ['ADMIT_ACTIONS', null, 'list[str]', enums.admit_action],
  ['GATE_RULES', null, 'list[dict[str, Any]]', gate.rules],
  ['AUDIT_OPS', null, 'list[str]', enums.audit_op],
  ['AUDIT_OPS_DEFERRED', null, 'list[str]', enums.audit_op_deferred],
  ['AUDIT_STORES', null, 'list[str]', enums.audit_store],
  ['AUDIT_ENTRY_FIELDS', null, 'list[dict[str, Any]]', audit.entry_fields],
  ['UNDO_MESSAGES', null, 'dict[str, str]', undoMessages],
  ['UNDO_MESSAGES_PYTHON_ONLY', null, 'list[str]', undoPythonOnly],
  ['INV16', null, 'dict[str, Any]', inv16],
]

const HEADER = [
  'DO NOT EDIT — generated from spec/memory-core.json by spec/gen-memory-core.mjs.',
  'Run `node spec/gen-memory-core.mjs` after editing the source. CI fails if this file is stale.',
  'Agent memory framework plan, phase M8 (shared contract).',
]

const snake = (k) => (/^[A-Z0-9_]+$/.test(k) ? k.toLowerCase() : k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase()))
const snakeKeys = (v) => {
  if (Array.isArray(v)) return v.map(snakeKeys)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [snake(k), snakeKeys(x)]))
  return v
}

const camel = (k) => (/^[A-Z0-9_]+$/.test(k) ? k : k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase()))
const camelKeys = (v) => {
  if (Array.isArray(v)) return v.map(camelKeys)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [camel(k), camelKeys(x)]))
  return v
}

// Python: black/ruff-stable literal (containers always exploded with magic trailing commas).
function py(v, ind = '') {
  if (v === null) return 'None'
  if (v === true) return 'True'
  if (v === false) return 'False'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') return JSON.stringify(v)
  const inner = ind + '    '
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]'
    return '[\n' + v.map((x) => `${inner}${py(x, inner)},\n`).join('') + ind + ']'
  }
  const e = Object.entries(v)
  if (e.length === 0) return '{}'
  return '{\n' + e.map(([k, x]) => `${inner}${JSON.stringify(k)}: ${py(x, inner)},\n`).join('') + ind + '}'
}

function renderPy() {
  const out = ['"""', ...HEADER, '"""', '', 'from __future__ import annotations', '', 'from typing import Any', '']
  for (const [name, , type, value] of EXPORTS) out.push('', `${name}: ${type} = ${py(snakeKeys(value))}`)
  out.push('')
  return out.join('\n').replace('\n\n\n', '\n\n')
}

function renderTs() {
  const out = ['/*', ...HEADER.map((l) => ` * ${l}`), ' */', '']
  for (const [name, , , value] of EXPORTS) out.push(`export const ${name} = ${JSON.stringify(camelKeys(value), null, 2)} as const`, '')
  return out.join('\n')
}

const targets = [
  { path: PY_OUT, content: renderPy(), label: 'adapter/harness/agent_memory/_core_generated.py' },
  { path: TS_OUT, content: renderTs(), label: 'packages/aielia/src/_memory-core-generated.ts' },
]

let stale = false
for (const { path, content, label } of targets) {
  if (CHECK) {
    let existing = ''
    try { existing = readFileSync(path, 'utf8') } catch { existing = '' }
    if (existing !== content) {
      console.error(`❌  ${label} is out of date. Run: node spec/gen-memory-core.mjs`)
      stale = true
    } else console.log(`✅  ${label} is up to date.`)
  } else {
    writeFileSync(path, content, 'utf8')
    console.log(`wrote ${label}`)
  }
}
if (CHECK && stale) process.exit(1)
