import { describe, it, expect, vi, afterEach } from 'vitest'
import { resolveNonInteractiveApprovalMode } from './non-interactive-mode.js'

describe('resolveNonInteractiveApprovalMode', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns undefined when the env var is unset', () => {
    expect(resolveNonInteractiveApprovalMode({})).toBeUndefined()
  })

  it('recognizes "decline"', () => {
    expect(resolveNonInteractiveApprovalMode({ ASSISTANT_NON_INTERACTIVE_APPROVAL: 'decline' })).toBe('decline')
  })

  it('recognizes "require-tty"', () => {
    expect(resolveNonInteractiveApprovalMode({ ASSISTANT_NON_INTERACTIVE_APPROVAL: 'require-tty' })).toBe('require-tty')
  })

  it('falls back to undefined and warns on an unrecognized value instead of silently guessing', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(resolveNonInteractiveApprovalMode({ ASSISTANT_NON_INTERACTIVE_APPROVAL: 'always-decline' })).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('always-decline'))
  })
})
