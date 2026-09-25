// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { reconcileGolden, runHarnessStaticBaseline, serializeHarnessBaseline, HARNESS_SCENARIOS } from './static-baseline.js'

const FILE = fileURLToPath(new URL('./static-baseline.json', import.meta.url))

describe('AL0b static golden baseline (harness)', () => {
  it('re-running the scripted runs reproduces the committed baseline byte-for-byte', async () => {
    const actual = serializeHarnessBaseline(await runHarnessStaticBaseline())
    expect(actual).toBe(readFileSync(FILE, 'utf8'))
  })

  it('records layer activity, node order and call counts for every scenario', () => {
    const baseline = JSON.parse(readFileSync(FILE, 'utf8')) as Awaited<ReturnType<typeof runHarnessStaticBaseline>>
    expect(baseline.runs.map((r) => r.scenario)).toEqual(HARNESS_SCENARIOS.map((s) => s.id))
    for (const r of baseline.runs) {
      expect(r.layerActivity.length).toBeGreaterThan(0)
      expect(r.callCounts.executor).toBeGreaterThan(0)
    }
    const stall = baseline.runs.find((r) => r.scenario === 'stall-supervisor-redirect')!
    expect(stall.callCounts.supervisor).toBe(1)
  })

  it('a differing baseline is only rewritten with --update-golden', () => {
    expect(reconcileGolden('old', 'new', false)).toEqual({ ok: false, write: false })
    expect(reconcileGolden('old', 'new', true)).toEqual({ ok: true, write: true })
  })
})
