import { describe, it, expect } from 'vitest'
import { retryFailedTaskEnabled } from './harness-bridge.js'

describe('retryFailedTaskEnabled (AUDIT_RETRY_FAILED_TASK)', () => {
  it('is off by default and for empty or unrecognised values', () => {
    expect(retryFailedTaskEnabled({})).toBe(false)
    expect(retryFailedTaskEnabled({ AUDIT_RETRY_FAILED_TASK: '' })).toBe(false)
    expect(retryFailedTaskEnabled({ AUDIT_RETRY_FAILED_TASK: '0' })).toBe(false)
    expect(retryFailedTaskEnabled({ AUDIT_RETRY_FAILED_TASK: 'maybe' })).toBe(false)
  })
  it.each(['1', 'true', 'on', 'yes', 'enabled', ' ENABLED '])('is on for %j', (v) => {
    expect(retryFailedTaskEnabled({ AUDIT_RETRY_FAILED_TASK: v })).toBe(true)
  })
})
