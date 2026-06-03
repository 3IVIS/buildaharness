#!/usr/bin/env node
/**
 * migrate-v0.2-to-v1.0.mjs
 *
 * Converts an Its Harness FlowSpec v0.2.0 file to v1.0.0.
 *
 * Changes applied:
 *   - spec_version: "0.2.0" → "1.0.0"
 *   - Adds harness_meta: { harness_version: "0.0.0", enabled: false } if absent
 *
 * All existing fields are preserved unchanged. The migrated flow is not
 * harness-enabled by default — set harness_meta.enabled: true manually once
 * harness node types have been added.
 *
 * Usage:
 *   node scripts/migrate-v0.2-to-v1.0.mjs <input.json> [output.json]
 *
 *   If output.json is omitted the migrated spec is printed to stdout.
 *   If input.json is "-" the spec is read from stdin.
 */

import { readFileSync, writeFileSync } from 'fs'

const [, , inputArg, outputArg] = process.argv

if (!inputArg) {
  console.error('Usage: node migrate-v0.2-to-v1.0.mjs <input.json> [output.json]')
  process.exit(1)
}

// ── Read input ────────────────────────────────────────────────────────────────

let raw
if (inputArg === '-') {
  raw = readFileSync('/dev/stdin', 'utf8')
} else {
  raw = readFileSync(inputArg, 'utf8')
}

let spec
try {
  spec = JSON.parse(raw)
} catch (err) {
  console.error(`Failed to parse JSON from ${inputArg}: ${err.message}`)
  process.exit(1)
}

// ── Validate source ───────────────────────────────────────────────────────────

if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
  console.error('Input must be a JSON object (FlowSpec)')
  process.exit(1)
}

if (spec.spec_version !== '0.2.0') {
  if (spec.spec_version === '1.0.0') {
    console.error(`Flow is already at v1.0.0 — no migration needed.`)
    process.exit(0)
  }
  console.error(`Expected spec_version "0.2.0", got "${spec.spec_version}"`)
  process.exit(1)
}

// ── Apply migration ───────────────────────────────────────────────────────────

const migrated = {
  ...spec,
  spec_version: '1.0.0',
  harness_meta: spec.harness_meta ?? {
    harness_version: '0.0.0',
    enabled: false,
  },
}

// ── Output ────────────────────────────────────────────────────────────────────

const output = JSON.stringify(migrated, null, 2)

if (outputArg) {
  writeFileSync(outputArg, output, 'utf8')
  console.error(`Migrated to v1.0.0 → ${outputArg}`)
} else {
  process.stdout.write(output + '\n')
}
