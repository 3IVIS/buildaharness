import { describe, it, expect } from 'vitest'
import { resolveTemplate } from './template'
import { FlowState } from './state'

function stateWith(data: Record<string, unknown>): FlowState {
  const s = new FlowState()
  for (const [k, v] of Object.entries(data)) s.set(k, v)
  return s
}

describe('resolveTemplate', () => {
  it('resolves {{question}} from flat FlowState key', () => {
    const state = stateWith({ question: 'What is AI?' })
    expect(resolveTemplate('Answer: {{question}}', state)).toBe('Answer: What is AI?')
  })

  it('resolves {{$.state.document}} JSONPath from FlowState', () => {
    const state = stateWith({ document: 'Hello doc' })
    expect(resolveTemplate('{{$.state.document}}', state)).toBe('Hello doc')
  })

  it('unresolved placeholder left as-is (does not throw on missing key)', () => {
    const state = stateWith({})
    expect(resolveTemplate('{{missing}}', state)).toBe('{{missing}}')
  })

  it('multiple placeholders in single string all resolved', () => {
    const state = stateWith({ a: 'foo', b: 'bar' })
    expect(resolveTemplate('{{a}} and {{b}}', state)).toBe('foo and bar')
  })

  it('resolves nested JSONPath like {{$.state.classification.severity}}', () => {
    const state = stateWith({ classification: { severity: 'high' } })
    expect(resolveTemplate('{{$.state.classification.severity}}', state)).toBe('high')
  })

  it('resolves plain key and $.state. prefix for the same key', () => {
    const state = stateWith({ x: 'val' })
    expect(resolveTemplate('{{x}} {{$.state.x}}', state)).toBe('val val')
  })
})
