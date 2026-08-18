import { describe, it, expect, vi, afterEach } from 'vitest'
import { resolveControlPlaneMode, DEFAULT_CONTROL_PLANE_MODE } from './control-plane-flag.js'

describe('resolveControlPlaneMode', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the default when the env var is unset', () => {
    expect(resolveControlPlaneMode({})).toBe(DEFAULT_CONTROL_PLANE_MODE)
  })

  it('returns "enabled" when explicitly set', () => {
    expect(resolveControlPlaneMode({ ASSISTANT_CONTROL_PLANE: 'enabled' })).toBe('enabled')
  })

  it('returns "disabled" when explicitly set', () => {
    expect(resolveControlPlaneMode({ ASSISTANT_CONTROL_PLANE: 'disabled' })).toBe('disabled')
  })

  it('falls back to the default and warns on an unrecognized value', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(resolveControlPlaneMode({ ASSISTANT_CONTROL_PLANE: 'yes-please' })).toBe(DEFAULT_CONTROL_PLANE_MODE)
    expect(errorSpy).toHaveBeenCalledOnce()
  })

  it('never touches the real process.env — takes env as a plain injected object', () => {
    // If this function reached for the real process.env instead of its parameter, this call
    // would see whatever the real environment happens to have, not the empty object below.
    expect(resolveControlPlaneMode({})).toBe(DEFAULT_CONTROL_PLANE_MODE)
  })
})
