// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { judgeAgreement } from './certify-probes.js'

describe('judgeAgreement', () => {
  it('compares the second-pass verdict with the run\'s own success and skips invalid rows', () => {
    const r = judgeAgreement([
      { oldSuccess: true, verdict: 'PASS' },
      { oldSuccess: false, verdict: 'FAIL' },
      { oldSuccess: true, verdict: 'FAIL' },
      { oldSuccess: true, verdict: 'INVALID_RUN' },
      { oldSuccess: false, verdict: 'JUDGE_ERROR' },
    ])
    expect(r).toEqual({ agree: 2, total: 3 })
  })
  it('is empty with no records', () => expect(judgeAgreement([])).toEqual({ agree: 0, total: 0 }))
})
