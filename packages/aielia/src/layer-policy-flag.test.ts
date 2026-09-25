import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  DEFAULT_LAYER_POLICY_MODE, resolveLayerPolicyMode, normalizeLayerPolicyMode, isAdaptivePolicyEnabled, isPolicyRecordingEnabled,
} from './layer-policy-flag.js'
import { envOverridesFromProcessEnv, parseConfigValue } from './cli-config.js'
import { classifyExecutionMode } from './execution-mode.js'
import { resolveTurnTier } from '@buildaharness/harness'

afterEach(() => { vi.restoreAllMocks() })

describe('layerPolicyMode flag', () => {
  it('unset ⇒ static (the default and kill switch)', () => {
    expect(DEFAULT_LAYER_POLICY_MODE).toBe('static')
    expect(resolveLayerPolicyMode({})).toBe('static')
    expect(isAdaptivePolicyEnabled(undefined)).toBe(false)
    expect(isPolicyRecordingEnabled(undefined)).toBe(false)
  })

  it('shadow records but is not adaptive; adaptive is both', () => {
    expect(isAdaptivePolicyEnabled('shadow')).toBe(false)
    expect(isPolicyRecordingEnabled('shadow')).toBe(true)
    expect(isAdaptivePolicyEnabled('adaptive')).toBe(true)
    expect(isAdaptivePolicyEnabled('static')).toBe(false)
  })

  it('env: honours explicit values, warns and defaults on a typo', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(envOverridesFromProcessEnv({ ASSISTANT_LAYER_POLICY: 'adaptive' })).toEqual({ layerPolicyMode: 'adaptive' })
    expect(envOverridesFromProcessEnv({ ASSISTANT_LAYER_POLICY: 'shadow' })).toEqual({ layerPolicyMode: 'shadow' })
    expect(envOverridesFromProcessEnv({})).not.toHaveProperty('layerPolicyMode')
    expect(envOverridesFromProcessEnv({ ASSISTANT_LAYER_POLICY: 'on' })).toEqual({ layerPolicyMode: 'static' })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('normalize names the caller-supplied var in the warning (the VITE_ twin)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(normalizeLayerPolicyMode('x', 'VITE_ASSISTANT_LAYER_POLICY')).toBe('static')
    expect(spy.mock.calls[0][0]).toContain('VITE_ASSISTANT_LAYER_POLICY')
    expect(normalizeLayerPolicyMode('')).toBe('static')
  })

  it('/config set layerPolicyMode accepts the three modes and rejects others', () => {
    expect(parseConfigValue('layerPolicyMode', 'shadow')).toBe('shadow')
    expect(() => parseConfigValue('layerPolicyMode', 'enabled')).toThrow(/layerPolicyMode/)
  })

  it('static/shadow tier mapping equals today\'s FAST/full split (AL-12)', () => {
    // isTrivial is only ever true on turns that need no approval (turn-intent-classifier's contract), so compare on that domain.
    for (const isTrivial of [true, false]) {
      const today = classifyExecutionMode({ isPlanCancelBypass: false, isBatchResearch: false, isTrivial, requiresApproval: false })
      for (const mode of ['static', 'shadow'] as const) {
        const tier = resolveTurnTier(
          { riskLevel: 'LOW', taskCount: 1, hasDurablePlan: false, consequentialTools: new Set(), isTrivial },
          undefined, mode,
        )
        expect(tier === 'T0').toBe(today === 'FAST')
        expect(tier === 'T2').toBe(today !== 'FAST')
      }
    }
  })
})
