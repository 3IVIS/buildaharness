import { describe, it, expect, vi } from 'vitest'
import { resolveSupervisorEnabled, DEFAULT_SUPERVISOR_ENABLED } from './supervisor-flag.js'

describe('resolveSupervisorEnabled', () => {
  it('defaults to enabled when unset or empty', () => {
    expect(DEFAULT_SUPERVISOR_ENABLED).toBe(true)
    expect(resolveSupervisorEnabled({})).toBe(true)
    expect(resolveSupervisorEnabled({ HARNESS_TRAJECTORY_SUPERVISOR: '' })).toBe(true)
    expect(resolveSupervisorEnabled({ HARNESS_TRAJECTORY_SUPERVISOR: '   ' })).toBe(true)
  })

  it.each(['1', 'true', 'YES', 'on', 'enabled'])('treats %s as enabled', (v) => {
    expect(resolveSupervisorEnabled({ HARNESS_TRAJECTORY_SUPERVISOR: v })).toBe(true)
  })

  it.each(['0', 'false', 'NO', 'off', 'disabled'])('treats %s as the explicit escape hatch (disabled)', (v) => {
    expect(resolveSupervisorEnabled({ HARNESS_TRAJECTORY_SUPERVISOR: v })).toBe(false)
  })

  it('falls back to the default with a warning on an unrecognized value', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(resolveSupervisorEnabled({ HARNESS_TRAJECTORY_SUPERVISOR: 'maybe' })).toBe(true)
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})
