import { describe, it, expect, vi, afterEach } from 'vitest'
import { DEFAULT_TUI_MODE, resolveTuiMode, normalizeTuiMode, shouldLaunchTuiApp } from './tui-mode-flag.js'

describe('resolveTuiMode', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('defaults to disabled when ASSISTANT_TUI is unset', () => {
    expect(resolveTuiMode({})).toBe('disabled')
    expect(DEFAULT_TUI_MODE).toBe('disabled')
  })

  it('honors an explicit "enabled"', () => {
    expect(resolveTuiMode({ ASSISTANT_TUI: 'enabled' })).toBe('enabled')
  })

  it('honors an explicit "disabled"', () => {
    expect(resolveTuiMode({ ASSISTANT_TUI: 'disabled' })).toBe('disabled')
  })

  it('falls back to the default and warns on an unrecognized value', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(resolveTuiMode({ ASSISTANT_TUI: 'yes-please' })).toBe(DEFAULT_TUI_MODE)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toContain('ASSISTANT_TUI')
  })
})

describe('normalizeTuiMode', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('treats undefined and empty string as the default', () => {
    expect(normalizeTuiMode(undefined)).toBe(DEFAULT_TUI_MODE)
    expect(normalizeTuiMode('')).toBe(DEFAULT_TUI_MODE)
  })

  it('passes "enabled"/"disabled" through', () => {
    expect(normalizeTuiMode('enabled')).toBe('enabled')
    expect(normalizeTuiMode('disabled')).toBe('disabled')
  })

  it('warns with the caller-supplied var name on a typo and falls back to the default', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(normalizeTuiMode('on', 'CUSTOM_VAR')).toBe(DEFAULT_TUI_MODE)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toContain('CUSTOM_VAR')
  })
})

describe('shouldLaunchTuiApp', () => {
  it('launches only when enabled and both streams are a real TTY', () => {
    expect(shouldLaunchTuiApp('enabled', true, true)).toBe(true)
  })

  it('never launches when disabled, regardless of TTY state', () => {
    expect(shouldLaunchTuiApp('disabled', true, true)).toBe(false)
  })

  it('falls through to readline for piped/scripted input (stdin not a TTY) even when enabled', () => {
    expect(shouldLaunchTuiApp('enabled', true, false)).toBe(false)
  })

  it('falls through to readline when stdout is redirected even when enabled', () => {
    expect(shouldLaunchTuiApp('enabled', false, true)).toBe(false)
  })
})
