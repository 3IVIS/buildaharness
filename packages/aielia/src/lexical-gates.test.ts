import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// AL4a: schema test for scripts/lexical-gates.json, the machine-readable inventory behind
// docs/adr/007-lexical-decisions.md. AL4b's lint builds on this file.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const inventory = JSON.parse(readFileSync(resolve(repoRoot, 'scripts/lexical-gates.json'), 'utf8')) as {
  sites: Array<{ id: string; file: string; line: number; class: string; decides: string; batch: number | null; rationale?: string }>
}

const MAX_SITES_PER_BATCH = 6
const BATCHES = [1, 2, 3, 4, 5]

describe('scripts/lexical-gates.json', () => {
  it('has unique ids and a valid class on every site', () => {
    const ids = inventory.sites.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const s of inventory.sites) {
      expect(['A', 'B', 'C']).toContain(s.class)
      expect(s.decides.length).toBeGreaterThan(0)
      expect(Number.isInteger(s.line) && s.line > 0).toBe(true)
    }
  })

  it('points every site at an existing file with that many lines', () => {
    for (const s of inventory.sites) {
      const path = resolve(repoRoot, s.file)
      expect(existsSync(path), `${s.id}: ${s.file} missing`).toBe(true)
      expect(readFileSync(path, 'utf8').split('\n').length, `${s.id}: line ${s.line} past EOF`).toBeGreaterThanOrEqual(s.line)
    }
  })

  it('gives every class-B site a batch 1-5, at most 6 per batch, and no other class a batch', () => {
    for (const s of inventory.sites) {
      if (s.class === 'B') expect(BATCHES, `${s.id} needs a batch`).toContain(s.batch)
      else expect(s.batch, `${s.id} is not class B`).toBeNull()
    }
    for (const b of BATCHES) {
      expect(inventory.sites.filter((s) => s.class === 'B' && s.batch === b).length).toBeLessThanOrEqual(MAX_SITES_PER_BATCH)
    }
  })

  it('requires a rationale on every class-A site (why it is non-linguistic)', () => {
    for (const s of inventory.sites.filter((x) => x.class === 'A')) {
      expect(s.rationale?.length ?? 0, `${s.id} needs a rationale`).toBeGreaterThan(0)
    }
  })

  it('stays within 30 class-B sites (else append AL6 phases)', () => {
    expect(inventory.sites.filter((s) => s.class === 'B').length).toBeLessThanOrEqual(30)
  })
})
