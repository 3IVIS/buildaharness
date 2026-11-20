import { describe, it, expect } from 'vitest'
import {
  PROCEDURE_HINT_MAX_CHARS, PROCEDURE_LIMITS, parseProcedureEntry, parseProcedureLibrary,
  procedureBody, renderProcedureHint, withProcedureHint,
} from './procedure-library.js'

const good = {
  id: 'split-compound',
  procedureClass: 'decomposition',
  evidenceStatus: 'screened',
  description: 'Split a compound request into independent parts first.',
  whenToUse: { taskClass: 'multi_step_plan', condition: 'The request has several separable asks.' },
  preconditions: ['The asks do not depend on each other'],
  checks: ['Each part has its own result'],
  verification: 'Every ask in the request is covered by one part.',
  steps: ['List the asks', 'Order them', 'Do each'],
}

describe('procedure library', () => {
  it('accepts a well-formed entry', () => {
    expect(parseProcedureEntry(good).ok).toBe(true)
  })

  it('rejects entries failing the shape', () => {
    const bad: unknown[] = [
      null, [], { ...good, evidenceStatus: 'trusted' }, { ...good, procedureClass: 'other' },
      { ...good, verification: '' }, { ...good, verification: undefined }, { ...good, steps: [] },
      { ...good, whenToUse: { taskClass: 'x' } }, { ...good, taskId: 'case-17' },
      { ...good, whenToUse: { ...good.whenToUse, extra: 1 } }, { ...good, id: 'has space' },
    ]
    for (const b of bad) expect(parseProcedureEntry(b).ok).toBe(false)
  })

  it('enforces the size caps by rejecting, not truncating', () => {
    expect(parseProcedureEntry({ ...good, description: 'x'.repeat(PROCEDURE_LIMITS.descriptionChars + 1) }).ok).toBe(false)
    expect(parseProcedureEntry({ ...good, steps: Array(PROCEDURE_LIMITS.listItems + 1).fill('s') }).ok).toBe(false)
    const big = { ...good, steps: Array(8).fill('y'.repeat(190)), checks: Array(8).fill('z'.repeat(190)) }
    expect(parseProcedureEntry(big)).toEqual({ ok: false, reason: 'over size cap' })
  })

  it('is a no-op with an empty or non-matching library', () => {
    const prompt = 'Do the step.'
    expect(withProcedureHint(prompt, undefined, 'decomposition', 'multi_step_plan')).toBe(prompt)
    expect(withProcedureHint(prompt, [], 'decomposition', 'multi_step_plan')).toBe(prompt)
    const lib = parseProcedureLibrary([good])
    expect(withProcedureHint(prompt, lib, 'decomposition', 'other_class')).toBe(prompt)
    expect(withProcedureHint(prompt, lib, 'tool_workflow', 'multi_step_plan')).toBe(prompt)
  })

  it('shows the evidence status and keeps the body out of the hint', () => {
    const lib = parseProcedureLibrary([good])
    const hint = renderProcedureHint(lib, 'decomposition', 'multi_step_plan')
    expect(hint).toContain('(screened)')
    expect(hint).toContain(good.description)
    expect(hint).not.toContain('List the asks')
    expect(procedureBody(lib, 'split-compound')).toContain('List the asks')
    expect(procedureBody(lib, 'missing')).toBeUndefined()
  })

  it('orders by evidence and bounds the hint', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ ...good, id: `p${i}`, evidenceStatus: i === 5 ? 'certified' : 'provisional' }))
    const hint = renderProcedureHint(parseProcedureLibrary(many), 'decomposition', 'multi_step_plan')
    expect(hint.indexOf('(certified)')).toBeLessThan(hint.indexOf('(provisional)'))
    expect(hint.split('\n- ').length - 1).toBeLessThanOrEqual(3)
    expect(hint.length).toBeLessThanOrEqual(PROCEDURE_HINT_MAX_CHARS + 120)
  })

  it('drops junk and duplicate ids when parsing a library', () => {
    expect(parseProcedureLibrary('nope')).toEqual([])
    expect(parseProcedureLibrary([good, good, { bad: true }])).toHaveLength(1)
  })
})
