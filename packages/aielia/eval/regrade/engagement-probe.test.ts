// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { TaskSpecSchema, type TaskSpec } from '../corpus/schema.js'
import { analyzeFeature, renderSaturationMarkdown, type SaturationRun } from './saturation.js'
import {
  probe,
  minimumDetectableEffect,
  nonDiagnosticTasks,
  engagementRate,
  controlFailureRate,
  runFromTranscript,
  type ProbeInput,
  type ProbeRun,
} from './engagement-probe.js'

const LAYER = 'contradiction'
const NOTE = 'Must surface the conflict and must not silently pick one of the two sources.'
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango']
let n = 0
function spec(role: 'stress' | 'calm-control', family: string, over: Partial<TaskSpec> = {}): TaskSpec {
  n++
  const prompt = [n, n * 7, n * 3 + 1, n * 11, n * 13, n * 17].map((k) => `${WORDS[k % 20]}${WORDS[Math.floor(k / 20) % 20]}`).join(' ')
  return TaskSpecSchema.parse({ id: `p-${n}`, category: 'lookup', intent: 'x', prompt, grader: { judge: { rubric: 'r' } }, note: NOTE, mechanism: 'semantic_contradiction', role, family, ...over })
}

/** A corpus that satisfies the breadth rule: 3 families × 4 stress, 6 calm controls. */
function goodTasks(): TaskSpec[] {
  const t: TaskSpec[] = []
  for (const f of ['a', 'b', 'c']) for (let i = 0; i < 4; i++) t.push(spec('stress', f))
  for (let i = 0; i < 6; i++) t.push(spec('calm-control', 'calm'))
  return t
}

function run(taskId: string, arm: string, seed: number, over: Partial<ProbeRun> = {}): ProbeRun {
  return { taskId, arm, seed, role: 'stress', success: true, invalid: false, firedLayers: [], llmCalls: 3, reply: 'r', ...over }
}

/** `n` stress tasks; on-arm fires the layer on `engagedN` of them, control fails on `failN`. */
function runs(nTasks: number, engagedN: number, failN: number, seeds = 3): ProbeRun[] {
  const out: ProbeRun[] = []
  for (let i = 0; i < nTasks; i++) for (let s = 1; s <= seeds; s++) {
    out.push(run(`t${i}`, 'on', s, { firedLayers: i < engagedN ? [LAYER] : [], reply: i < failN ? 'fixed' : 'r', success: true }))
    out.push(run(`t${i}`, 'off', s, { success: i >= failN }))
  }
  return out
}

function input(over: Partial<ProbeInput> = {}): ProbeInput {
  return { mechanism: 'semantic_contradiction', activityLayer: LAYER, onArm: 'on', offArm: 'off', runs: runs(20, 16, 10), tasks: goodTasks(), judge: { agree: 98, total: 100 }, plannedSeeds: 3, justifyingEffect: 0.3, ...over }
}

describe('engagement probe — certificate', () => {
  it('certifies when every threshold holds', () => {
    const c = probe(input())
    expect(c.failed).toEqual([])
    expect(c.certified).toBe(true)
    expect(c.thresholds.map((t) => t.name)).toEqual(['engagement', 'headroom', 'breadth', 'judge_agreement', 'mde'])
    expect(c.stressRuns).toBe(60)
  })

  it('engagement: passes at 60%, fails below', () => {
    expect(engagementRate(input({ runs: runs(10, 6, 5) }))).toBeCloseTo(0.6)
    expect(probe(input({ runs: runs(10, 6, 5) })).thresholds[0].pass).toBe(true)
    const low = probe(input({ runs: runs(10, 5, 5) }))
    expect(low.thresholds[0].pass).toBe(false)
    expect(low.failed[0]).toMatch(/^engagement:/)
  })

  it('engagement: falls back to an LLM-call delta when the layer has no activity event', () => {
    const rs = runs(10, 0, 5).map((r) => (r.arm === 'on' ? { ...r, llmCalls: 5 } : r))
    expect(engagementRate(input({ runs: rs, activityLayer: undefined }))).toBe(1)
    expect(engagementRate(input({ runs: runs(10, 0, 5), activityLayer: undefined }))).toBe(0)
  })

  it('headroom: fails when the control is saturated or floored, passes inside 25–75%', () => {
    expect(controlFailureRate(runs(20, 20, 10), 'off')).toBeCloseTo(0.5)
    expect(probe(input({ runs: runs(20, 20, 5) })).thresholds[1].pass).toBe(true) // exactly 25%
    const sat = probe(input({ runs: runs(20, 20, 4) })) // 20%
    expect(sat.thresholds[1].pass).toBe(false)
    expect(sat.thresholds[1].detail).toMatch(/saturated/)
    const hard = probe(input({ runs: runs(20, 20, 16) })) // 80%
    expect(hard.thresholds[1].pass).toBe(false)
    expect(hard.thresholds[1].detail).toMatch(/too hard/)
  })

  it('breadth: fails when the family/calm-control minimums are not met', () => {
    const c = probe(input({ tasks: goodTasks().slice(0, 8) }))
    expect(c.thresholds[2].pass).toBe(false)
    expect(c.certified).toBe(false)
  })

  it('judge agreement: passes at 95%, fails below, fails with no verdicts', () => {
    expect(probe(input({ judge: { agree: 95, total: 100 } })).thresholds[3].pass).toBe(true)
    expect(probe(input({ judge: { agree: 94, total: 100 } })).thresholds[3].pass).toBe(false)
    expect(probe(input({ judge: { agree: 0, total: 0 } })).thresholds[3].pass).toBe(false)
  })

  it('MDE: shrinks with n; fails when the justifying effect is smaller than what the runs can detect', () => {
    expect(minimumDetectableEffect(400, 0.5)).toBeLessThan(minimumDetectableEffect(100, 0.5))
    expect(minimumDetectableEffect(0, 0.5)).toBe(Infinity)
    const c = probe(input({ justifyingEffect: 0.05 }))
    expect(c.thresholds[4].pass).toBe(false)
    expect(c.failed.some((f) => f.startsWith('mde:'))).toBe(true)
  })

  it('reports every failed threshold at once', () => {
    const c = probe(input({ runs: runs(5, 0, 0), judge: { agree: 1, total: 2 }, tasks: [] }))
    expect(c.certified).toBe(false)
    expect(c.failed.length).toBeGreaterThanOrEqual(4)
  })

  it('ignores invalid runs and calm controls', () => {
    const rs = [...runs(10, 10, 5), run('bad', 'on', 1, { invalid: true }), run('calm', 'on', 1, { role: 'calm-control' })]
    expect(engagementRate(input({ runs: rs }))).toBe(1)
    expect(probe(input({ runs: rs })).stressRuns).toBe(30)
  })
})

describe('engagement probe — non-diagnostic task check', () => {
  it('flags a stress task that is indistinguishable across arms and never fired', () => {
    const rs = [run('dead', 'on', 1), run('dead', 'off', 1), run('dead', 'on', 2), run('dead', 'off', 2)]
    expect(nonDiagnosticTasks({ runs: rs, onArm: 'on', offArm: 'off', activityLayer: LAYER })).toEqual(['dead'])
  })
  it('does not flag when the layer fired, or when the arms differ', () => {
    const fired = [run('t', 'on', 1, { firedLayers: [LAYER] }), run('t', 'off', 1)]
    expect(nonDiagnosticTasks({ runs: fired, onArm: 'on', offArm: 'off', activityLayer: LAYER })).toEqual([])
    const differs = [run('t', 'on', 1), run('t', 'off', 1, { success: false })]
    expect(nonDiagnosticTasks({ runs: differs, onArm: 'on', offArm: 'off', activityLayer: LAYER })).toEqual([])
    const diffCalls = [run('t', 'on', 1, { llmCalls: 4 }), run('t', 'off', 1)]
    expect(nonDiagnosticTasks({ runs: diffCalls, onArm: 'on', offArm: 'off', activityLayer: LAYER })).toEqual([])
  })
  it('is surfaced on the certificate', () => {
    const c = probe(input({ runs: [...runs(10, 6, 5), run('dead', 'on', 1), run('dead', 'off', 1)] }))
    expect(c.nonDiagnosticTasks).toContain('dead')
  })
})

describe('runFromTranscript', () => {
  it('derives fired layers, LLM calls, invalid and role from a saved transcript', () => {
    const t = spec('stress', 'a')
    const r = runFromTranscript(
      {
        task: t.id, arm: 'on', seed: '2',
        events: [
          { kind: 'llm_request' },
          { kind: 'trace', detail: { kind: 'layer_activity', layer: 'contradiction', fired: true } },
          { kind: 'trace', detail: { kind: 'layer_activity', layer: 'recovery', fired: false } },
          { kind: 'llm_request' },
        ],
        grade: { success: false, verdict: 'INVALID_TASK' },
        replyPreview: '  a   b ',
      },
      new Map([[t.id, t]]),
    )
    expect(r).toMatchObject({ role: 'stress', firedLayers: ['contradiction'], llmCalls: 2, invalid: true, success: false, reply: 'a b' })
  })
})

describe('saturation analysis', () => {
  const sat = (arm: string, task: string, seed: number, over: Partial<SaturationRun> = {}): SaturationRun => ({ ...run(task, arm, seed), category: 'lookup', ...over })

  it('flags a category where both arms pass > 90%', () => {
    const rs = [sat('c', 't1', 1), sat('x', 't1', 1, { llmCalls: 5 })]
    const cells = analyzeFeature('f', 'c', 'x', rs)
    expect(cells).toHaveLength(1)
    expect(cells[0].reasons).toEqual(['both_arms_saturated'])
  })
  it('flags low engagement even without saturation', () => {
    const rs: SaturationRun[] = []
    for (let i = 0; i < 10; i++) rs.push(sat('c', `t${i}`, 1, { success: i < 5 }), sat('x', `t${i}`, 1, { success: i < 5 }))
    const cells = analyzeFeature('f', 'c', 'x', rs)
    expect(cells[0].reasons).toEqual(['low_engagement'])
    expect(cells[0].engagement).toBe(0)
  })
  it('does not flag a category with headroom and engagement', () => {
    const rs: SaturationRun[] = []
    for (let i = 0; i < 10; i++) rs.push(sat('c', `t${i}`, 1, { success: i < 4 }), sat('x', `t${i}`, 1, { success: i < 8, llmCalls: 6 }))
    expect(analyzeFeature('f', 'c', 'x', rs)).toEqual([])
  })
  it('ignores invalid runs and renders a table', () => {
    const rs = [sat('c', 't1', 1), sat('x', 't1', 1), sat('c', 't2', 1, { invalid: true, success: false })]
    const cells = analyzeFeature('f', 'c', 'x', rs)
    const md = renderSaturationMarkdown(cells, 1, '2026-01-01')
    expect(md).toContain('| f | lookup | 100% | 100% |')
    expect(renderSaturationMarkdown([], 1, '2026-01-01')).toContain('No saturated')
  })
})
