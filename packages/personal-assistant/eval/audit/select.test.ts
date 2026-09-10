import { describe, it, expect } from 'vitest'
import { nextCell, matrixComplete } from './select.js'
import { parseManifest, parseProgress, validateManifestArms } from './types.js'
import type { AuditManifest, AuditProgress } from './types.js'

function manifest(...features: Array<Partial<AuditManifest['features'][number]> & { id: string }>): AuditManifest {
  return parseManifest({
    features: features.map((f) => ({
      title: f.id,
      hypothesis: 'x',
      arms: ['control', 'candidate'],
      slice: null,
      seeds: 3,
      status: 'queued',
      ...f,
    })),
  })
}

function progress(features: Record<string, Record<string, unknown>>): AuditProgress {
  return parseProgress({ features })
}

describe('nextCell', () => {
  it('empty manifest → nothing to do, not blocked', () => {
    expect(nextCell(manifest(), progress({}))).toEqual({ cell: null, blocked: false })
  })

  it('fresh feature → seed 1', () => {
    const { cell } = nextCell(manifest({ id: 'feat-a' }), progress({}))
    expect(cell).toMatchObject({ kind: 'seed', feature: 'feat-a', seed: 1, totalSeeds: 3 })
  })

  it('1/3 seeds done → seed 2', () => {
    const { cell } = nextCell(manifest({ id: 'feat-a' }), progress({ 'feat-a': { seedsDone: 1 } }))
    expect(cell).toMatchObject({ kind: 'seed', seed: 2 })
  })

  it('3/3 seeds done, not finalized → finalize', () => {
    const { cell } = nextCell(manifest({ id: 'feat-a' }), progress({ 'feat-a': { seedsDone: 3 } }))
    expect(cell).toMatchObject({ kind: 'finalize', feature: 'feat-a', seeds: 3 })
  })

  it('finalized → advances to the next feature', () => {
    const { cell } = nextCell(
      manifest({ id: 'feat-a' }, { id: 'feat-b' }),
      progress({ 'feat-a': { seedsDone: 3, finalized: true } }),
    )
    expect(cell).toMatchObject({ kind: 'seed', feature: 'feat-b', seed: 1 })
  })

  it('status done → skipped even with no progress entry', () => {
    const { cell } = nextCell(
      manifest({ id: 'feat-a', status: 'done' }, { id: 'feat-b' }),
      progress({}),
    )
    expect(cell).toMatchObject({ feature: 'feat-b' })
  })

  it('status needs_manual_review → skipped', () => {
    const { cell } = nextCell(
      manifest({ id: 'feat-a', status: 'needs_manual_review' }, { id: 'feat-b' }),
      progress({}),
    )
    expect(cell).toMatchObject({ feature: 'feat-b' })
  })

  it('blocked progress entry → halt (cell null, blocked true), does not skip past', () => {
    expect(
      nextCell(manifest({ id: 'feat-a' }, { id: 'feat-b' }), progress({ 'feat-a': { blocked: true } })),
    ).toEqual({ cell: null, blocked: true })
  })

  it('carries the arm pair and slice through', () => {
    const { cell } = nextCell(
      manifest({ id: 'feat-a', arms: ['bare', 'flagOn'], slice: 'supervisor_pivot' }),
      progress({}),
    )
    expect(cell).toMatchObject({ arms: ['bare', 'flagOn'], slice: 'supervisor_pivot' })
  })

  it('carries excludeSlice through on both a seed cell and a finalize cell', () => {
    const m = manifest({ id: 'feat-a', arms: ['bare', 'flagOn'], slice: null, excludeSlice: 'supervisor_pivot,supervisor_lookup', seeds: 2 })
    expect(nextCell(m, progress({})).cell).toMatchObject({ kind: 'seed', excludeSlice: 'supervisor_pivot,supervisor_lookup' })
    expect(nextCell(m, progress({ 'feat-a': { seedsDone: 2 } })).cell).toMatchObject({ kind: 'finalize', excludeSlice: 'supervisor_pivot,supervisor_lookup' })
  })
})

describe('matrixComplete', () => {
  it('true when every feature finalized', () => {
    const m = manifest({ id: 'a' }, { id: 'b' })
    const p = progress({ a: { seedsDone: 3, finalized: true }, b: { seedsDone: 3, finalized: true } })
    expect(matrixComplete(m, p)).toBe(true)
  })

  it('false when a seed is still pending', () => {
    expect(matrixComplete(manifest({ id: 'a' }), progress({}))).toBe(false)
  })

  it('false when blocked (halt, do not retire)', () => {
    expect(matrixComplete(manifest({ id: 'a' }), progress({ a: { blocked: true } }))).toBe(false)
  })
})

describe('validateManifestArms', () => {
  it('flags an unknown arm', () => {
    const m = manifest({ id: 'a', arms: ['control', 'nope'] })
    expect(validateManifestArms(m, ['control', 'candidate'])).toEqual([
      'feature "a": unknown arm "nope"',
    ])
  })

  it('flags identical control/candidate', () => {
    const m = manifest({ id: 'a', arms: ['flagOn', 'flagOn'] })
    expect(validateManifestArms(m, ['flagOn'])).toContain(
      'feature "a": control and candidate arms are identical ("flagOn")',
    )
  })

  it('passes a well-formed pair', () => {
    const m = manifest({ id: 'a', arms: ['bare', 'flagOn'] })
    expect(validateManifestArms(m, ['bare', 'flagOn'])).toEqual([])
  })
})
