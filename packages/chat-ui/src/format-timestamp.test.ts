import { describe, it, expect } from 'vitest'
import { formatTimestamp } from './format-timestamp'

describe('formatTimestamp', () => {
  const now = new Date(2026, 9, 6, 15, 0, 0)

  it('shows time for today', () => {
    expect(formatTimestamp(new Date(2026, 9, 6, 9, 5).toISOString(), now)).toBe('today 09:05')
  })

  it('says yesterday for the previous calendar day', () => {
    expect(formatTimestamp(new Date(2026, 9, 5, 23, 59).toISOString(), now)).toBe('yesterday')
  })

  it('uses a short date otherwise', () => {
    expect(formatTimestamp(new Date(2026, 6, 1, 10, 0).toISOString(), now)).toBe('1 Jul 2026')
  })

  it('returns unparseable input unchanged', () => {
    expect(formatTimestamp('not a date', now)).toBe('not a date')
  })
})
