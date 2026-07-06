import { describe, it, expect } from 'vitest'
import { classifyPlanningCandidate } from './planning-classifier.js'
import type { DecomposedTaskSpec } from './decomposition-classifier.js'

function tasks(n: number): DecomposedTaskSpec[] {
  return Array.from({ length: n }, (_, i) => ({ id: `t${i}`, description: `task ${i}`, depends_on: i > 0 ? [`t${i - 1}`] : [] }))
}

describe('classifyPlanningCandidate', () => {
  it('is a candidate with a confident template match and 4+ decomposed tasks', () => {
    const result = classifyPlanningCandidate('Help me plan and launch the new product roadmap.', tasks(4))
    expect(result.isCandidate).toBe(true)
    expect(result.matchedTemplate).toBe('project_planning')
  })

  it('is not a candidate with a confident match but fewer than 4 decomposed tasks', () => {
    const result = classifyPlanningCandidate('Help me plan and launch the new product roadmap.', tasks(2))
    expect(result.isCandidate).toBe(false)
    expect(result.matchedTemplate).toBeNull()
  })

  it('is not a candidate with 4+ decomposed tasks but no template keyword match', () => {
    const result = classifyPlanningCandidate('xyzzy plugh qux corge grault garply', tasks(5))
    expect(result.isCandidate).toBe(false)
    expect(result.matchedTemplate).toBeNull()
  })

  it('is not a candidate when decomposed is null (decomposition classifier never triggered)', () => {
    const result = classifyPlanningCandidate('Help me plan and launch the new product roadmap.', null)
    expect(result.isCandidate).toBe(false)
  })

  it('does not throw on an empty decomposed array', () => {
    expect(() => classifyPlanningCandidate('plan a launch', [])).not.toThrow()
    expect(classifyPlanningCandidate('plan a launch', []).isCandidate).toBe(false)
  })
})
