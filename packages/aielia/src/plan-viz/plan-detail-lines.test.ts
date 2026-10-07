import { describe, expect, it } from 'vitest'
import { planDetailLines } from './plan-detail-lines.js'
import type { VizNode } from './types.js'

const nodes: VizNode[] = [
  { id: 'a', label: 'Gather the quarterly numbers from every regional office', status: 'done', deps: [] },
  { id: 'b', label: 'Summarize', status: 'running', deps: ['a'] },
]

describe('planDetailLines', () => {
  it('shows full label, status, dependencies and dependents', () => {
    const text = planDetailLines(nodes, 'a', 30).join('\n')
    expect(text).toContain('Gather the quarterly numbers')
    expect(text).toContain('Status: done')
    expect(text).toContain('Depends on: nothing')
    expect(text).toContain('Needed by: b')
  })
  it('wraps within the width and handles a missing selection', () => {
    expect(planDetailLines(nodes, 'a', 20).every((l) => l.length <= 20)).toBe(true)
    expect(planDetailLines(nodes, undefined, 20)).toEqual(['No task selected.'])
    expect(planDetailLines(nodes, 'b', 20).join('\n')).toContain('Depends on: a')
  })
  it('strips terminal escape and control characters from ids and labels', () => {
    const evil = [{ id: 'x\u001b]0;pwn\u0007', label: 'hi\u001b[2Jthere\u0000', status: 'pending' as const, deps: [] }]
    const text = planDetailLines(evil, evil[0].id, 30).join('\n')
    expect(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(text)).toBe(false)
    expect(text).toContain('there')
  })
})
