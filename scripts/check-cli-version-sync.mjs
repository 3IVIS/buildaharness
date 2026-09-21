#!/usr/bin/env node
/**
 * Verifies packages/aielia/src/version.ts's CLI_VERSION matches packages/aielia/package.json's
 * version. version.ts is checked into git (a bundled binary has no package.json to read at
 * runtime), so this guards it against drifting when the package is bumped.
 *
 * Run manually:  node scripts/check-cli-version-sync.mjs
 * Run in CI:     same command; exits 1 on mismatch.
 */
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync('packages/aielia/package.json', 'utf8'))
const src = readFileSync('packages/aielia/src/version.ts', 'utf8')
const m = src.match(/export const CLI_VERSION\s*=\s*['"]([^'"]+)['"]/)

if (!m) {
  console.error('check-cli-version-sync: could not find CLI_VERSION in packages/aielia/src/version.ts')
  process.exit(1)
}
if (m[1] !== pkg.version) {
  console.error(
    `check-cli-version-sync: CLI_VERSION (${m[1]}) != packages/aielia/package.json version (${pkg.version}) — update version.ts`,
  )
  process.exit(1)
}
console.log(`check-cli-version-sync: OK (${pkg.version})`)
