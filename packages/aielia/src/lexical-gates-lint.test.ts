import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error — plain .mjs shared with scripts/check-lexical-gates.mjs, no type declarations
import { scanTree, scanSource, findViolations } from '../../../scripts/lexical-gate-scan.mjs'

// AL4b: fails when shipped source gains a natural-language regex gate that is not classified in
// scripts/lexical-gates.json. Runs inside `npm run test:aielia` so the existing gate enforces it.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const inventory = JSON.parse(readFileSync(resolve(repoRoot, 'scripts/lexical-gates.json'), 'utf8'))

describe('lexical-gate lint', () => {
  it('passes on the current tree', () => {
    expect(findViolations(scanTree(), inventory)).toEqual([])
  })

  it('counts keyword-list regexes and dynamic RegExp but ignores mechanical ones, strings and comments', () => {
    expect(scanSource('const r = /\\b(yes|okay|sure)\\b/i')).toBe(1)
    expect(scanSource('const r = new RegExp(userWords.join("|"))')).toBe(1)
    expect(scanSource('const r = /^\\d+$/; const u = "https://x.io/a/b/c"; // /approve|reject/')).toBe(0)
  })

  it('fails on a deliberately added new natural-language regex gate in a known file', () => {
    const file = 'packages/aielia/src/action-snapshot.ts'
    const scan = { ...scanTree() }
    scan[file] = (scan[file] ?? 0) + scanSource('if (/\\b(please|kindly)\\b/.test(msg)) go()')
    const v = findViolations(scan, inventory)
    expect(v).toHaveLength(1)
    expect(v[0]).toContain(file)
  })

  it('fails on a natural-language regex in a file the inventory does not know', () => {
    const v = findViolations({ 'packages/aielia/src/brand-new.ts': 1 }, inventory)
    expect(v[0]).toContain('brand-new.ts')
  })
})
