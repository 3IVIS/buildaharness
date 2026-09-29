import { describe, it, expect } from 'vitest'
import {
  HarnessRuntime,
  type LayerActivityEvent,
  type SemanticHypothesisEvent,
  type SemanticHypothesesHook,
  type SemanticHypothesisJudge,
} from './harness-runtime.js'
import type { Task } from './state/task-graph.js'

const task = (id: string, dependsOn: string[] = []): Task => ({
  id, description: id, status: 'PENDING', risk_level: 'LOW', depends_on: dependsOn,
  parallel_write_domains: [], abstraction_level: 1, assigned_strategy: null,
})

const proposals = [
  { explanation: 'The export includes soft-deleted rows the dashboard filters out', predicted_observations: ['soft-deleted rows present'], separating_check: 'Count rows where deleted_at is set' },
  { explanation: 'The dashboard was refreshed before late-arriving rows landed', predicted_observations: ['rows with timestamps after the refresh'], separating_check: 'Compare the dashboard refresh time to max(created_at)' },
]

async function run(opts: {
  hook?: SemanticHypothesesHook
  judge?: SemanticHypothesisJudge
  tasks?: Task[]
}) {
  const events: SemanticHypothesisEvent[] = []
  const layers: LayerActivityEvent[] = []
  const outcome = await new HarnessRuntime().run('why do the counts differ', ['done'], {
    initialTasks: opts.tasks ?? [task('t1')],
    max_steps: 20,
    toolExecutors: { default: () => ({ __harnessExecutionStatus: 'complete', output: 'checked something' }) },
    semanticHypotheses: opts.hook,
    semanticHypothesisJudge: opts.judge,
    onSemanticHypothesis: (e) => events.push(e),
    onLayerActivity: (e) => layers.push(e),
  })
  return { events, layers, outcome }
}

const hypothesisLines = (layers: LayerActivityEvent[]) => layers.filter((l) => l.layer === 'hypothesis').map((l) => l.reason)

describe('semantic hypotheses — generation', () => {
  it('without the hook nothing semantic happens and the layer line is the template one', async () => {
    const { events, layers, outcome } = await run({})
    expect(outcome.status).toBe('complete')
    expect(events).toEqual([])
    expect(hypothesisLines(layers).every((r) => !r.startsWith('Weighing'))).toBe(true)
  })

  it('a hook that proposes two explanations adds them, tagged semantic, and reports them', async () => {
    let calls = 0
    const { events, layers } = await run({ hook: async () => { calls++; return proposals } })
    expect(calls).toBe(1)
    const generated = events.find((e) => e.kind === 'generated')
    expect(generated && generated.kind === 'generated' ? generated.hypotheses.map((h) => h.explanation) : []).toEqual(proposals.map((p) => p.explanation))
    expect(generated && generated.kind === 'generated' ? generated.hypotheses[0].separating_check : '').toBe('Count rows where deleted_at is set')
    expect(hypothesisLines(layers)).toContain('Weighing 2 competing explanations for this request')
  })

  it('is asked exactly once even across several iterations', async () => {
    let calls = 0
    await run({ hook: async () => { calls++; return proposals }, tasks: [task('t1'), task('t2', ['t1']), task('t3', ['t2'])] })
    expect(calls).toBe(1)
  })

  it('is asked once even when it answers with nothing', async () => {
    let calls = 0
    const { events } = await run({ hook: async () => { calls++; return null }, tasks: [task('t1'), task('t2', ['t1'])] })
    expect(calls).toBe(1)
    expect(events).toEqual([])
  })

  it('fails open: an empty list, a throw and blank explanations all leave the run untouched', async () => {
    for (const hook of [async () => [], async () => { throw new Error('boom') }, async () => [{ explanation: '  ', predicted_observations: [] }]] as SemanticHypothesesHook[]) {
      const { events, outcome } = await run({ hook })
      expect(outcome.status).toBe('complete')
      expect(events).toEqual([])
    }
  })
})

describe('semantic hypotheses — elimination', () => {
  it('the judge sees the semantic hypotheses and only the new observations, and what it contradicts is eliminated', async () => {
    const seen: Array<{ ids: string[]; observations: string[] }> = []
    const judge: SemanticHypothesisJudge = async (input) => {
      seen.push({ ids: input.hypotheses.map((h) => h.id), observations: input.observations })
      return { contradicted: [{ id: 'sem_0', reason: 'no soft-deleted rows exist' }] }
    }
    const { events } = await run({ hook: async () => proposals, judge })
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[0].ids).toEqual(['sem_0', 'sem_1'])
    expect(seen[0].observations.length).toBeGreaterThan(0)
    const eliminated = events.filter((e) => e.kind === 'eliminated')
    expect(eliminated.map((e) => (e.kind === 'eliminated' ? e.id : ''))).toEqual(['sem_0'])
    expect(eliminated[0].kind === 'eliminated' ? eliminated[0].reason : '').toBe('no soft-deleted rows exist')
  })

  it('an eliminated hypothesis is not shown to the judge again', async () => {
    const seen: string[][] = []
    const judge: SemanticHypothesisJudge = async (input) => {
      seen.push(input.hypotheses.map((h) => h.id))
      return { contradicted: [{ id: 'sem_0' }] }
    }
    await run({ hook: async () => proposals, judge, tasks: [task('t1'), task('t2', ['t1'])] })
    expect(seen[0]).toEqual(['sem_0', 'sem_1'])
    for (const later of seen.slice(1)) expect(later).not.toContain('sem_0')
  })

  it('the judge is not consulted when no semantic hypotheses exist', async () => {
    let calls = 0
    await run({ judge: async () => { calls++; return { contradicted: [] } } })
    expect(calls).toBe(0)
  })

  it('fails open: a judge that throws, answers null or names an unknown id eliminates nothing', async () => {
    for (const judge of [async () => { throw new Error('boom') }, async () => null, async () => ({ contradicted: [{ id: 'nope' }] })] as SemanticHypothesisJudge[]) {
      const { events, outcome } = await run({ hook: async () => proposals, judge })
      expect(outcome.status).toBe('complete')
      expect(events.filter((e) => e.kind === 'eliminated')).toEqual([])
    }
  })
})
