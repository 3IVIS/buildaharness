import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseManifest, validateManifestArms } from './types.js'
import { ALL_ARMS } from '../arms.js'
import { BENCHMARK_SLICES } from '../corpus/schema.js'
import { loadCorpus } from '../corpus/index.js'

/**
 * A7 — the seeded feature-value-audit matrix. `feature_audit_driver.py` reads this file every
 * wakeup; a bad arm name or an unknown slice would only surface as a mid-run subprocess failure,
 * so gate it here (plan A7 Validation item 1).
 */
describe('eval/audit/manifest.json', () => {
  const raw = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'manifest.json'), 'utf8'),
  ) as unknown
  const manifest = parseManifest(raw)
  const knownArms = ALL_ARMS.map((a) => a.name)
  const knownSlices: readonly string[] = BENCHMARK_SLICES
  const corpus = loadCorpus()

  it('validates against AuditManifestSchema', () => {
    expect(manifest.features.length).toBeGreaterThan(0)
  })

  it('every arm exists in ALL_ARMS and control !== candidate', () => {
    expect(validateManifestArms(manifest, knownArms)).toEqual([])
  })

  it('feature ids are unique and kebab-case', () => {
    const ids = manifest.features.map((f) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/)
  })

  it('every non-null slice is a known BENCHMARK_SLICES value with >= 1 corpus task', () => {
    for (const f of manifest.features) {
      if (f.slice === null) continue
      for (const part of f.slice.split(',').map((s) => s.trim())) {
        expect(knownSlices, `feature "${f.id}": slice "${part}" is not a known BENCHMARK_SLICES value`).toContain(part)
        const hits = corpus.filter((t) => t.slice === part).length
        expect(hits, `feature "${f.id}": slice "${part}" matches no corpus task`).toBeGreaterThan(0)
      }
    }
  })

  it('every excludeSlice part is a known slice with >= 1 corpus task, and only on a full-corpus feature', () => {
    for (const f of manifest.features) {
      if (!f.excludeSlice) continue
      expect(f.slice, `feature "${f.id}": excludeSlice requires slice: null`).toBeNull()
      for (const part of f.excludeSlice.split(',').map((s) => s.trim())) {
        expect(knownSlices, `feature "${f.id}": excludeSlice "${part}" is not a known slice`).toContain(part)
        expect(corpus.filter((t) => t.slice === part).length).toBeGreaterThan(0)
      }
    }
  })
})
