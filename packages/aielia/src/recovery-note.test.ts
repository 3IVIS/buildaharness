import { describe, it, expect } from 'vitest'
import { RECOVERY_NOTE_PREFIX, recoveryNoteText, learnedRecoveryNoteText } from './recovery-note.js'

describe('learnedRecoveryNoteText', () => {
  it('names the strategy hint and says it is what worked in earlier runs', () => {
    const note = learnedRecoveryNoteText('timeout', 'BROADER_SEARCH')
    expect(note).toContain('(timeout)')
    expect(note).toContain('in earlier runs')
    expect(note).toContain('broaden the search')
  })
  it('an unmatched failure has no class to name', () => {
    expect(learnedRecoveryNoteText('', 'TRACE_EXEC')).toMatch(/^That failed — in earlier runs/)
  })
  it('is distinct from the failure-mode note, which claims only a recognized pattern', () => {
    expect(learnedRecoveryNoteText('timeout', 'ESCALATE')).not.toBe(recoveryNoteText('timeout', 'ESCALATE'))
    expect(recoveryNoteText('timeout', 'ESCALATE')).toContain('recognized pattern')
  })
  it('an unknown strategy falls back to the generic hint', () => {
    expect(learnedRecoveryNoteText('x', 'NOT_A_STRATEGY')).toContain('different approach')
  })
  it('the prefix is shared with the failure-mode note so the proposer drains both the same way', () => {
    expect(RECOVERY_NOTE_PREFIX).toBe('[recovery] ')
  })
})
