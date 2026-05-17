#!/usr/bin/env node
/**
 * Fix #8: validate:example script rewritten as a CJS file so it can use
 * require() correctly.  The old version mixed ESM dynamic import() with
 * require() in the same execution context, which throws ReferenceError in ESM.
 *
 * Usage: node scripts/validate-example.cjs <path-to-flow.json>
 */
'use strict'
const { FlowSpec } = require('../dist/cjs/schema')
const fs           = require('fs')
const path         = require('path')

const filePath = process.argv[2]
if (!filePath) {
  console.error('Usage: node scripts/validate-example.cjs <path-to-flow.json>')
  process.exit(1)
}

const raw    = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'))
const result = FlowSpec.safeParse(raw)

if (!result.success) {
  console.error('Validation failed:')
  result.error.issues.forEach((issue) =>
    console.error(`  [${issue.path.join('.')}] ${issue.message}`)
  )
  process.exit(1)
}
console.log(`✅  ${path.basename(filePath)} is valid`)
