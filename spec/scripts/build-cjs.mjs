/**
 * Fix #7: Replace the fragile regex-based ESM→CJS transform with a proper
 * dual-compilation build: tsc produces both CJS (dist/cjs/) and ESM (dist/esm/)
 * outputs directly from TypeScript — no string manipulation needed.
 *
 * This script adds the package.json marker files that Node.js uses to treat
 * dist/cjs/ as CommonJS and dist/esm/ as ESM, then copies a unified type
 * declaration to dist/.
 */
import { writeFileSync, copyFileSync, mkdirSync } from 'fs'

// Mark dist/cjs as CommonJS
mkdirSync('./dist/cjs', { recursive: true })
writeFileSync('./dist/cjs/package.json', JSON.stringify({ type: 'commonjs' }))

// Mark dist/esm as ESM
mkdirSync('./dist/esm', { recursive: true })
writeFileSync('./dist/esm/package.json', JSON.stringify({ type: 'module' }))

// Copy the CJS declaration to the root dist/ for older tooling
copyFileSync('./dist/cjs/schema.d.ts', './dist/schema.d.ts')

console.log('Dual-format build markers written.')
console.log('  dist/cjs/schema.js   → CommonJS')
console.log('  dist/esm/schema.js   → ESM')
