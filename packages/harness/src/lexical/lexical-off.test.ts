import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_HARNESS_LEXICAL_MODE,
  HARNESS_LEXICAL_CHECKS,
  harnessLexicalActive,
  resolveHarnessLexicalOff,
  setHarnessLexicalMode,
} from './lexical-off.js'
import { WorldModel } from '../state/world-model.js'
import { EvidenceStore } from '../state/evidence-store.js'
import { HypothesisSet } from '../state/hypothesis-set.js'
import { MemoryState } from '../state/memory-state.js'
import { TaskGraph, type Task } from '../state/task-graph.js'
import { CallerState, updateSuccessCriteria } from '../state/caller-state.js'
import { detectContradictions } from '../nodes/detect-contradictions.js'
import { FailureModeLibrary } from '../state/failure-diagnostics.js'
import { reviewProposedChange } from '../nodes/review-proposed-change.js'
import { execute } from '../nodes/execute.js'
import { revalidateTaskGraph } from '../nodes/check-caller-updates.js'
import { outputValidation } from '../nodes/output-validation.js'
import { OutputContract } from '../state/output-contract.js'
import { makePreferenceExtractor } from '../primitives/preference-extractor.js'

const VARS = ['HARNESS_LEXICAL_MODE', 'HARNESS_LEXICAL_ON', 'HARNESS_LEXICAL_OFF'] as const
let saved: Record<string, string | undefined> = {}
beforeEach(() => {
  saved = Object.fromEntries(VARS.map(v => [v, process.env[v]]))
  for (const v of VARS) delete process.env[v]
  setHarnessLexicalMode(undefined)
})
afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v]
    else process.env[v] = saved[v]
  }
  setHarnessLexicalMode(undefined)
})

const belief = (id: string, statement: string, confidence = 0.9) =>
  ({ id, statement, confidence, derived_from: [`o-${id}`], recorded_at: '' })
const opposed = (): WorldModel => {
  const wm = new WorldModel()
  wm.beliefs.push(belief('b1', 'the service is available', 0.6), belief('b2', 'the service is unavailable', 0.6))
  return wm
}
// Three mutually opposed high-confidence beliefs: the pairwise AND the set-level detector fire on these.
const opposedTriple = (): WorldModel => {
  const wm = new WorldModel()
  wm.beliefs.push(
    belief('b1', 'the deploy build passed'),
    belief('b2', 'the deploy build failed'),
    belief('b3', 'the deploy build passed again'),
  )
  return wm
}
const library = () =>
  new FailureModeLibrary([{ id: 'f1', failure_class: 'timeout', symptoms: ['connection timed out'], pattern_description: 'timeout' }])
const contradictionTypes = (wm: WorldModel) => {
  detectContradictions(wm, new EvidenceStore(), new HypothesisSet())
  return wm.contradictions.map(c => c.type)
}

describe('resolution', () => {
  it('defaults to every check off', () => {
    expect(DEFAULT_HARNESS_LEXICAL_MODE).toBe('disabled')
    expect(resolveHarnessLexicalOff({}).size).toBe(HARNESS_LEXICAL_CHECKS.length)
    for (const c of HARNESS_LEXICAL_CHECKS) expect(harnessLexicalActive(c, {})).toBe(false)
  })
  it('HARNESS_LEXICAL_MODE=enabled turns every check on', () => {
    for (const c of HARNESS_LEXICAL_CHECKS) expect(harnessLexicalActive(c, { HARNESS_LEXICAL_MODE: 'enabled' })).toBe(true)
  })
  it('HARNESS_LEXICAL_ON turns only the named checks on; unknown names are ignored', () => {
    const env = { HARNESS_LEXICAL_ON: 'negation-pairs, nonsense' }
    expect(harnessLexicalActive('negation-pairs', env)).toBe(true)
    expect(harnessLexicalActive('review-negation', env)).toBe(false)
    for (const c of HARNESS_LEXICAL_CHECKS) expect(harnessLexicalActive(c, { HARNESS_LEXICAL_ON: 'all' })).toBe(true)
  })
  it('HARNESS_LEXICAL_OFF turns the named checks off even under enabled, and wins over ON', () => {
    const env = { HARNESS_LEXICAL_MODE: 'enabled', HARNESS_LEXICAL_OFF: 'negation-pairs' }
    expect(harnessLexicalActive('negation-pairs', env)).toBe(false)
    expect(harnessLexicalActive('review-negation', env)).toBe(true)
    expect(harnessLexicalActive('negation-pairs', { HARNESS_LEXICAL_ON: 'all', HARNESS_LEXICAL_OFF: 'negation-pairs' })).toBe(false)
    for (const c of HARNESS_LEXICAL_CHECKS) expect(harnessLexicalActive(c, { HARNESS_LEXICAL_MODE: 'enabled', HARNESS_LEXICAL_OFF: 'all' })).toBe(false)
  })
  it('a host can set the mode where there is no process.env; an explicit HARNESS_LEXICAL_MODE still wins', () => {
    setHarnessLexicalMode('enabled')
    expect(harnessLexicalActive('negation-pairs', {})).toBe(true)
    expect(harnessLexicalActive('negation-pairs', { HARNESS_LEXICAL_MODE: 'disabled' })).toBe(false)
    setHarnessLexicalMode(undefined)
    expect(harnessLexicalActive('negation-pairs', {})).toBe(false)
  })
})

describe('default: every lexical detector is silent', () => {
  it('negation-pairs: neither the pairwise nor the set-level detector fires', () => {
    expect(contradictionTypes(opposedTriple())).toEqual([])
  })
  it('failure-exact-match: match() returns null but the entries stay visible to a semantic matcher', () => {
    const lib = library()
    expect(lib.match(['error: connection timed out after 30s'])).toBeNull()
    expect(lib.getEntries()).toHaveLength(1)
  })
  it('review-negation: a phrase-level conflict with a high-confidence belief passes', () => {
    const wm = new WorldModel()
    wm.beliefs.push(belief('b1', 'login is required'))
    expect(reviewProposedChange({ description: 'remove login is required' }, null, wm, null, null, null, new Map()).passed).toBe(true)
  })
  it('system-error-symptoms: the raw error text is kept unprefixed', async () => {
    const es = new EvidenceStore()
    const task = (): Task => ({ id: 't1', description: 'x', status: 'RUNNING', risk_level: 'LOW', depends_on: [], parallel_write_domains: [], abstraction_level: 1, assigned_strategy: null })
    const ctx = { worldModel: new WorldModel(), evidenceStore: es, taskGraph: new TaskGraph({ tasks: [task()] }), currentTask: task(), memoryState: new MemoryState() }
    await execute({}, () => { throw new Error('ETIMEDOUT: request timed out') }, ctx as never)
    expect(es.observations.find(e => e.evidence_type === 'SYSTEM_ERROR')!.obs).toBe('Tool execution failed: ETIMEDOUT: request timed out')
  })
  it('criterion-scope: a task sharing no word with the new criteria is not blocked, and no belief is flagged stale', () => {
    const tg = new TaskGraph({ tasks: [{ id: 't1', description: 'write the summary', status: 'PENDING', risk_level: 'LOW', depends_on: [], parallel_write_domains: [], abstraction_level: 1, assigned_strategy: null }] })
    revalidateTaskGraph(tg, new CallerState({ success_criteria: ['budget approved'] }))
    expect(tg.tasks.map(t => t.status)).toEqual(['PENDING'])
    const wm = new WorldModel()
    wm.beliefs.push(belief('b1', 'the sky is blue'))
    updateSuccessCriteria(new CallerState({ success_criteria: ['budget approved'] }), wm)
    expect(wm.stale_flags['b1']).toBeUndefined()
  })
  it('constraint-negation: a reply naming a negated subject is not rejected by word match', () => {
    const cs = new CallerState({ current_constraints: ['Do not use tabs'] })
    expect(() => outputValidation('I will not use tabs; spaces only.', new OutputContract(), cs)).not.toThrow()
  })
  it('preference-patterns: a matching phrase produces no update', () => {
    const extract = makePreferenceExtractor([{ patterns: ['concise'], field: 'field_x', value: 'short' }])
    const updates = extract({ feedback_text: 'please be concise' })['preference_updates'] as Record<string, unknown> | undefined
    expect(updates?.['field_x']).toBeUndefined()
  })
})

describe('switched back on', () => {
  it('negation-pairs on: the pairwise and set-level detectors both fire', () => {
    process.env.HARNESS_LEXICAL_ON = 'negation-pairs'
    const types = contradictionTypes(opposedTriple())
    expect(types).toContain('pairwise')
    expect(types).toContain('set-level')
  })
  it('enabled: the exact library match and the review negation work as before', () => {
    process.env.HARNESS_LEXICAL_MODE = 'enabled'
    expect(library().match(['error: connection timed out after 30s'])?.failure_class).toBe('timeout')
    const wm = new WorldModel()
    wm.beliefs.push(belief('b1', 'login is required'))
    expect(reviewProposedChange({ description: 'remove login is required' }, null, wm, null, null, null, new Map()).passed).toBe(false)
  })
  it('one check off under enabled leaves the others on', () => {
    process.env.HARNESS_LEXICAL_MODE = 'enabled'
    process.env.HARNESS_LEXICAL_OFF = 'failure-exact-match'
    expect(contradictionTypes(opposed())).toEqual(['pairwise'])
    expect(library().match(['error: connection timed out after 30s'])).toBeNull()
  })
})
