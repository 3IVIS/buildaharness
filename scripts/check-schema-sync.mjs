#!/usr/bin/env node
/**
 * Fix #35: verifies that src/spec/schema.ts exports the same public type and
 * const names as the canonical spec/schema.ts.
 *
 * This does NOT enforce line-for-line equality (the canvas copy intentionally
 * omits .refine() calls). It enforces that every export from the canonical
 * schema is present in the canvas copy, so divergence is caught in CI.
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

const canonical = readFileSync('spec/schema.ts', 'utf8')
const canvas    = readFileSync('src/spec/schema.ts', 'utf8')

const canonicalExports = extractExports(canonical)
const canvasExports    = extractExports(canvas)

const missing = [...canonicalExports].filter((name) => !canvasExports.has(name))

if (missing.length > 0) {
  console.error('❌  src/spec/schema.ts is missing exports that exist in spec/schema.ts:')
  missing.forEach((name) => console.error(`     - ${name}`))
  console.error('\nSync the canvas schema with the canonical spec, then re-run.')
  process.exit(1)
}

const extras = [...canvasExports].filter((name) => !canonicalExports.has(name))
if (extras.length > 0) {
  // Canvas-only additions (e.g. AnyNode, ADAPTER_LABELS) are allowed — just report them.
  console.warn('ℹ️   Canvas-only exports (not in canonical spec — this is OK):')
  extras.forEach((name) => console.warn(`     + ${name}`))
}

console.log(`✅  Schema sync OK — ${canonicalExports.size} canonical exports all present in canvas copy.`)
