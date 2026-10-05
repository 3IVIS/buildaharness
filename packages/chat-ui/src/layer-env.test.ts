import { describe, it, expect, afterEach } from 'vitest'
import { applyBrowserLayerSettings } from './layer-env'

const env = () => (globalThis as { process: { env: Record<string, string | undefined> } }).process.env

describe('applyBrowserLayerSettings', () => {
  afterEach(() => { applyBrowserLayerSettings({}) })

  // That these flags are what the layers' own gates read is covered in aielia's layer-settings.test.ts.
  it('writes saved choices onto the flags and restores them when the choice is cleared', () => {
    applyBrowserLayerSettings({ semantic_hypotheses: true, decomposition_reframe: false })
    expect(env().AUDIT_SEMANTIC_HYPOTHESES).toBe('1')
    expect(env().AUDIT_DECOMPOSITION).toBe('0')
    applyBrowserLayerSettings({})
    expect(env().AUDIT_SEMANTIC_HYPOTHESES).toBeUndefined()
    expect(env().AUDIT_DECOMPOSITION).toBeUndefined()
  })

  it('reports a flag set outside Settings as pinned and leaves it alone', () => {
    env().AUDIT_DECOMPOSITION = '1'
    try {
      const pinned = applyBrowserLayerSettings({ decomposition_reframe: false })
      expect(pinned.has('decomposition_reframe')).toBe(true)
      expect(env().AUDIT_DECOMPOSITION).toBe('1')
    } finally { delete env().AUDIT_DECOMPOSITION }
  })
})
