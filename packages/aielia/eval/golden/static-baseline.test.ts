// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { reconcileGolden, runStaticBaseline, serializeBaseline, SCENARIOS } from './static-baseline.js'

const FILE = fileURLToPath(new URL('./static-baseline.json', import.meta.url))

describe('AL0b static golden baseline (aielia)', () => {
  it('re-running the scripted turns reproduces the committed baseline byte-for-byte', async () => {
    const actual = serializeBaseline(await runStaticBaseline())
    expect(actual).toBe(readFileSync(FILE, 'utf8'))
  })

  it('covers at least 25 turns and every required path, with no turn that threw', () => {
    const baseline = JSON.parse(readFileSync(FILE, 'utf8')) as Awaited<ReturnType<typeof runStaticBaseline>>
    expect(baseline.turns.length).toBeGreaterThanOrEqual(25)
    expect(baseline.turns.filter((t) => t.status === 'threw')).toEqual([])
    expect(baseline.categories).toEqual(SCENARIOS.map((s) => s.category))
    expect(baseline.categories).toHaveLength(13)
    // The recorded shape is what later phases diff: layers, node order, call counts by purpose, reply.
    const tool = baseline.turns.find((t) => t.scenario === 'ordinary-tool')!
    expect(tool.layerActivity.length).toBeGreaterThan(0)
    expect(tool.nodeExecutionOrder.length).toBeGreaterThan(0)
    expect(tool.llmCalls.classify_turn_intent).toBe(1)
    expect(tool.reply).toBe('The file says: hello from a seeded file')
    // The stall scenario really consulted the supervisor.
    const stall = baseline.turns.find((t) => t.scenario === 'stall-supervisor')!
    expect(Object.keys(stall.llmCalls).some((k) => k.includes('trajectory supervisor'))).toBe(true)
  })

  it('a differing baseline is only rewritten with --update-golden', () => {
    expect(reconcileGolden('old', 'new', false)).toEqual({ ok: false, write: false })
    expect(reconcileGolden('old', 'new', true)).toEqual({ ok: true, write: true })
    expect(reconcileGolden(undefined, 'new', false)).toEqual({ ok: false, write: false })
    expect(reconcileGolden('same', 'same', false)).toEqual({ ok: true, write: false })
  })
})
