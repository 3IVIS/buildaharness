#!/usr/bin/env node
// AL4b: CLI wrapper around scripts/lexical-gate-scan.mjs for CI. The same check runs inside
// `npm run test:aielia` via packages/aielia/src/lexical-gates-lint.test.ts.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { repoRoot, scanTree, findViolations } from './lexical-gate-scan.mjs'

const inventory = JSON.parse(readFileSync(resolve(repoRoot, 'scripts/lexical-gates.json'), 'utf8'))
const violations = findViolations(scanTree(), inventory)
if (violations.length) {
  console.error('Lexical-gate lint failed:\n' + violations.map((v) => '  - ' + v).join('\n'))
  process.exit(1)
}
console.log('Lexical-gate lint: ok')
