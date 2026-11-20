import { describe, it, expect } from 'vitest'
import { LAYER_SETTINGS } from './layer-settings.js'
import { ADVISOR_LAYER_IDS, SURFACE_REGISTRY, protectedLayers, isKernelPath, kernelOverlaps, isAdvisorLayerId, type AdvisorLayerId, type SurfaceSpec } from './harness-surfaces.js'

const FLOOR = ['control_state', 'tool_policy', 'mandatory_verification', 'approval_staging', 'diagnostics', 'hypothesis']

describe('surface registry', () => {
  it('has no floor layer', () => {
    for (const id of FLOOR) {
      expect(isAdvisorLayerId(id)).toBe(false)
      expect(SURFACE_REGISTRY.some((s) => s.layerId === id)).toBe(false)
    }
  })

  it('covers every switchable non-floor layer and nothing else', () => {
    const expected = LAYER_SETTINGS.filter((l) => l.group !== 'floor' && l.flag).map((l) => l.id).sort()
    expect([...ADVISOR_LAYER_IDS].sort()).toEqual(expected)
    expect(SURFACE_REGISTRY.map((s) => s.layerId).sort()).toEqual(expected)
  })

  it('cannot represent a floor id in the type', () => {
    // @ts-expect-error floor layers are not advisor layers
    const bad: AdvisorLayerId = 'control_state'
    expect(isAdvisorLayerId(bad)).toBe(false)
  })

  it('has an empty protected set by default', () => {
    expect(protectedLayers.size).toBe(0)
  })

  it('has no surface path on the kernel list', () => {
    expect(kernelOverlaps()).toEqual([])
  })

  it('negative control: an overlapping surface is caught', () => {
    const bad: SurfaceSpec = { ...SURFACE_REGISTRY[0]!, id: 'bad', slot: undefined, path: 'packages/aielia/src/tool-policy.ts' }
    expect(kernelOverlaps([...SURFACE_REGISTRY, bad]).map((s) => s.id)).toEqual(['bad'])
    expect(kernelOverlaps([{ ...bad, path: 'packages/aielia/src/new-thing.test.ts' }]).length).toBe(1)
  })
})

describe('isKernelPath', () => {
  it('matches exact, directory and suffix patterns', () => {
    expect(isKernelPath('packages/aielia/src/tool-policy.ts')).toBe(true)
    expect(isKernelPath('.github/workflows/ci.yml')).toBe(true)
    expect(isKernelPath('packages/proxy/src/index.ts')).toBe(true)
    expect(isKernelPath('packages/aielia/src/anything.test.ts')).toBe(true)
    expect(isKernelPath('packages/aielia/src/layer-policy-rules.ts')).toBe(false)
    expect(isKernelPath('packages/harness/src/recovery-policy.ts')).toBe(false)
  })
  it('honours an extra private list', () => {
    expect(isKernelPath('x/graders.ts')).toBe(false)
    expect(isKernelPath('x/graders.ts', ['x/graders.ts'])).toBe(true)
  })
})
