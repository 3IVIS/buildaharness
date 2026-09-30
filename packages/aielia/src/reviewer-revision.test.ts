import { describe, it, expect } from 'vitest'
import type { ReviewerVerdict } from '@buildaharness/harness'
import {
  reviewerRevisionEnabled,
  isCheckableCriterion,
  reviewerRevisionNote,
  revisionContextMessage,
  REVISION_NOTE_PREFIX,
} from './reviewer-revision.js'
import { NON_CHECKABLE_DEFAULT_CRITERION } from './semantic-criterion-coverage.js'

const verdict = (severity: ReviewerVerdict['severity'], lens: ReviewerVerdict['lens'], summary = 'a finding'): ReviewerVerdict => ({ severity, lens, summary })

describe('reviewerRevisionEnabled (AUDIT_REVIEWER_REVISION)', () => {
  it('is OFF unless a truthy value is set', () => {
    expect(reviewerRevisionEnabled({})).toBe(false)
    expect(reviewerRevisionEnabled({ AUDIT_REVIEWER_REVISION: '' })).toBe(false)
    for (const v of ['0', 'false', 'off', 'no', 'disabled']) expect(reviewerRevisionEnabled({ AUDIT_REVIEWER_REVISION: v }), v).toBe(false)
    for (const v of ['1', 'true', 'on', 'yes', 'enabled', ' ON ']) expect(reviewerRevisionEnabled({ AUDIT_REVIEWER_REVISION: v }), v).toBe(true)
  })
})

describe('isCheckableCriterion', () => {
  it('the generic default is not checkable; a real criterion is', () => {
    expect(isCheckableCriterion(NON_CHECKABLE_DEFAULT_CRITERION)).toBe(false)
    expect(isCheckableCriterion('the migration is verified against production')).toBe(true)
  })
})

describe('reviewerRevisionNote — which verdicts earn a second answer', () => {
  it('HIGH from any lens does', () => {
    for (const lens of ['implementer', 'reviewer', 'adversarial'] as const) {
      expect(reviewerRevisionNote(verdict('HIGH', lens, 'contradiction'))).toBe(`${REVISION_NOTE_PREFIX}contradiction`)
    }
  })

  it('MEDIUM from the implementer lens does (a real criterion nothing covers)', () => {
    expect(reviewerRevisionNote(verdict('MEDIUM', 'implementer', 'criterion not covered'))).toBe(`${REVISION_NOTE_PREFIX}criterion not covered`)
  })

  it('MEDIUM from the reviewer or adversarial lens does not (they describe the run, not the answer)', () => {
    expect(reviewerRevisionNote(verdict('MEDIUM', 'reviewer'))).toBeNull()
    expect(reviewerRevisionNote(verdict('MEDIUM', 'adversarial'))).toBeNull()
  })

  it('LOW never does', () => {
    expect(reviewerRevisionNote(verdict('LOW', 'implementer'))).toBeNull()
  })
})

describe('revisionContextMessage', () => {
  it('states the finding, asks for a corrected answer and forbids repeating it', () => {
    const msg = revisionContextMessage('Success criterion not covered by any belief: "x"')
    expect(msg).toContain('Success criterion not covered by any belief: "x"')
    expect(msg).toContain('Answer again')
    expect(msg).toContain('Do not just repeat the same answer')
  })
})
