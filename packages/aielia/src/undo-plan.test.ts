import { describe, it, expect } from 'vitest'
import { planUndo } from './undo-plan.js'

describe('planUndo', () => {
  it('has nothing to undo for an empty transcript', () => {
    expect(planUndo([])).toEqual({ nothingToUndo: true })
  })
  it('is a completed turn when the last message is the assistant reply', () => {
    expect(planUndo([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }])).toEqual({ nothingToUndo: false, wasPendingApproval: false })
  })
  it('is a pending approval when the last message is the user request', () => {
    expect(planUndo([{ role: 'user', content: 'delete it' }])).toEqual({ nothingToUndo: false, wasPendingApproval: true })
  })
})
