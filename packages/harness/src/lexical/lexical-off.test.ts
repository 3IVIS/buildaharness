import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HARNESS_LEXICAL_CHECKS, harnessLexicalActive, resolveHarnessLexicalOff } from './lexical-off.js'
import { WorldModel } from '../state/world-model.js'
import { EvidenceStore } from '../state/evidence-store.js'
import { HypothesisSet } from '../state/hypothesis-set.js'
import { detectContradictions } from '../nodes/detect-contradictions.js'
import { FailureModeLibrary } from '../state/failure-diagnostics.js'
import { reviewProposedChange } from '../nodes/review-proposed-change.js'

let saved: string | undefined
beforeEach(() => {
  saved = process.env.HARNESS_LEXICAL_OFF
  delete process.env.HARNESS_LEXICAL_OFF
})
afterEach(() => {
  if (saved === undefined) delete process.env.HARNESS_LEXICAL_OFF
  else process.env.HARNESS_LEXICAL_OFF = saved
})

const opposed = (): WorldModel => {
  const wm = new WorldModel()
  wm.beliefs.push({ id: 'b1', statement: 'the service is available', confidence: 0.6, derived_from: ['o1'], recorded_at: '' })
  wm.beliefs.push({ id: 'b2', statement: 'the service is unavailable', confidence: 0.6, derived_from: ['o2'], recorded_at: '' })
  return wm
}
const library = () =>
  new FailureModeLibrary([{ id: 'f1', failure_class: 'timeout', symptoms: ['connection timed out'], pattern_description: 'timeout' }])

describe('resolution', () => {
  it('defaults to everything active', () => {
    expect(resolveHarnessLexicalOff({}).size).toBe(0)
    for (const c of HARNESS_LEXICAL_CHECKS) expect(harnessLexicalActive(c, {})).toBe(true)
  })
  it('all switches every check off; a comma list switches only those; unknown names are ignored', () => {
    for (const c of HARNESS_LEXICAL_CHECKS) expect(harnessLexicalActive(c, { HARNESS_LEXICAL_OFF: 'all' })).toBe(false)
    const env = { HARNESS_LEXICAL_OFF: 'negation-pairs, nonsense' }
    expect(harnessLexicalActive('negation-pairs', env)).toBe(false)
    expect(harnessLexicalActive('review-negation', env)).toBe(true)
  })
})

describe('default (unset) is byte-identical', () => {
  it('the pairwise negation detector still fires', () => {
    const wm = opposed()
    detectContradictions(wm, new EvidenceStore(), new HypothesisSet())
    expect(wm.contradictions).toHaveLength(1)
  })
  it('the exact library match still matches', () => {
    expect(library().match(['error: connection timed out after 30s'])?.failure_class).toBe('timeout')
  })
})

describe('HARNESS_LEXICAL_OFF', () => {
  it('negation-pairs: the pairwise detector finds nothing', () => {
    process.env.HARNESS_LEXICAL_OFF = 'negation-pairs'
    const wm = opposed()
    detectContradictions(wm, new EvidenceStore(), new HypothesisSet())
    expect(wm.contradictions).toHaveLength(0)
  })
  it('failure-exact-match: match() returns null but the entries stay visible to a semantic matcher', () => {
    process.env.HARNESS_LEXICAL_OFF = 'failure-exact-match'
    const lib = library()
    expect(lib.match(['error: connection timed out after 30s'])).toBeNull()
    expect(lib.getEntries()).toHaveLength(1)
  })
  it('review-negation: a phrase-level conflict with a high-confidence belief fails the review by default and passes with the check off', () => {
    const wm = new WorldModel()
    wm.beliefs.push({ id: 'b1', statement: 'login is required', confidence: 0.9, derived_from: ['o1'], recorded_at: '' })
    const run = () => reviewProposedChange({ description: 'remove login is required' }, null, wm, null, null, null, new Map())
    expect(run().passed).toBe(false)
    process.env.HARNESS_LEXICAL_OFF = 'review-negation'
    expect(run().passed).toBe(true)
  })
  it('one check off leaves the others on', () => {
    process.env.HARNESS_LEXICAL_OFF = 'failure-exact-match'
    const wm = opposed()
    detectContradictions(wm, new EvidenceStore(), new HypothesisSet())
    expect(wm.contradictions).toHaveLength(1)
  })
})
