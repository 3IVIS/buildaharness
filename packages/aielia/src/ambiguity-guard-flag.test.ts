import { describe, it, expect, vi, afterEach } from 'vitest'
import { DEFAULT_AMBIGUITY_GUARD_MODE, resolveAmbiguityGuardMode, normalizeAmbiguityGuardMode } from './ambiguity-guard-flag.js'

describe('ambiguity guard flag', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('defaults to disabled (AL-8: flag-off is the pre-AL3a behaviour)', () => {
    expect(DEFAULT_AMBIGUITY_GUARD_MODE).toBe('disabled')
    expect(resolveAmbiguityGuardMode({})).toBe('disabled')
    expect(normalizeAmbiguityGuardMode('')).toBe('disabled')
  })

  it('honors explicit values', () => {
    expect(resolveAmbiguityGuardMode({ ASSISTANT_AMBIGUITY_GUARD: 'enabled' })).toBe('enabled')
    expect(resolveAmbiguityGuardMode({ ASSISTANT_AMBIGUITY_GUARD: 'disabled' })).toBe('disabled')
  })

  it('warns and falls back on a typo', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(normalizeAmbiguityGuardMode('on', 'VITE_ASSISTANT_AMBIGUITY_GUARD')).toBe('disabled')
    expect(spy.mock.calls[0][0]).toContain('VITE_ASSISTANT_AMBIGUITY_GUARD')
  })
})
