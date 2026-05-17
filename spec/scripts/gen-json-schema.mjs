/**
 * Regenerates spec/schema.json from the compiled CJS output.
 * Fix #41: run with --check in CI to fail if schema.json is stale.
 * Fix #8:  uses CJS dist output; no ESM/CJS mixing.
 *
 * Usage:
 *   node scripts/gen-json-schema.mjs            # regenerate
 *   node scripts/gen-json-schema.mjs --check    # CI mode: fail if stale
 */
import { readFileSync, writeFileSync } from 'fs'
import { execSync } from 'child_process'
import { createRequire } from 'module'

const CHECK   = process.argv.includes('--check')
const require  = createRequire(import.meta.url)

// Build CJS output first
execSync('npm run build', { stdio: 'inherit' })

// Now safe to require() — CJS output is in dist/cjs/
const { FlowSpec }         = require('../dist/cjs/schema.js')
const { zodToJsonSchema }  = require('zod-to-json-schema')

const generated = JSON.stringify(
  zodToJsonSchema(FlowSpec, { name: 'FlowSpec', $refStrategy: 'none' }),
  null,
  2,
) + '\n'

if (CHECK) {
  const committed = readFileSync('./schema.json', 'utf8')
  if (generated !== committed) {
    console.error('schema.json is out of date. Run: npm run gen:json-schema')
    process.exit(1)
  }
  console.log('✅  schema.json is up to date.')
} else {
  writeFileSync('./schema.json', generated, 'utf8')
  console.log('schema.json regenerated.')
}
