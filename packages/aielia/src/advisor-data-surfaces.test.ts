import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ADVISOR_SURFACE_REGISTRY, DATA_SURFACES, HARNESS_CORE_ALLOWLIST, UNREGISTERED_SURFACE_IDS, checkCapabilityGrant, checkSurfaceValue, dataSurfaceKernelOverlaps, isHarnessCoreKeyAllowed } from './advisor-data-surfaces.js'
import { kernelOverlaps, isAdvisorLayerId } from './harness-surfaces.js'

describe('data surfaces', () => {
  it('registers surfaces D, F, G, H with unique ids, scope and beacon', () => {
    const ids = ADVISOR_SURFACE_REGISTRY.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const prefix of ['plan:', 'tool:', 'preset:', 'memory:', 'core:']) expect(ids.some((i) => i.startsWith(prefix))).toBe(true)
    for (const s of DATA_SURFACES) {
      expect(s.scope.length).toBeGreaterThan(0)
      expect(s.beacon.kind).toBe('slot_read')
      expect(s.class).toBe('I')
    }
  })
  it('passes the kernel and floor tests', () => {
    expect(kernelOverlaps(ADVISOR_SURFACE_REGISTRY)).toEqual([])
    expect(dataSurfaceKernelOverlaps()).toEqual([])
    expect(ADVISOR_SURFACE_REGISTRY.some((s) => s.layerId !== undefined && !isAdvisorLayerId(s.layerId))).toBe(false)
  })
  it('does not register E1 or kernel-owned logic', () => {
    for (const id of UNREGISTERED_SURFACE_IDS) expect(ADVISOR_SURFACE_REGISTRY.some((s) => s.id === id)).toBe(false)
    expect(ADVISOR_SURFACE_REGISTRY.some((s) => /reviewer|hypothes|permission|write_gate/.test(s.id) && !s.id.startsWith('layer:'))).toBe(false)
  })
  it('rejects a capability need beyond the grant', () => {
    const mem = DATA_SURFACES.find((s) => s.id === 'memory:budget_chars')!
    expect(checkCapabilityGrant(mem, ['memory_parameter'])).toEqual({ ok: true })
    expect(checkCapabilityGrant(mem, ['memory_parameter', 'memory_write_gate']).ok).toBe(false)
    expect(checkCapabilityGrant(mem, ['tool_exposure']).ok).toBe(false)
  })
  it('validates values against the schema', () => {
    const budget = DATA_SURFACES.find((s) => s.id === 'memory:budget_chars')!
    expect(checkSurfaceValue(budget, 4000).ok).toBe(true)
    expect(checkSurfaceValue(budget, 10).ok).toBe(false)
    expect(checkSurfaceValue(budget, NaN).ok).toBe(false)
    const preset = DATA_SURFACES.find((s) => s.id === 'preset:backend')!
    expect(checkSurfaceValue(preset, 'claude-cli').ok).toBe(true)
    expect(checkSurfaceValue(preset, 'custom-plugin').ok).toBe(false)
  })
})

describe('harness-core allowlist', () => {
  it('names only keys that exist, and everything else is frozen', () => {
    const core = JSON.parse(readFileSync(fileURLToPath(new URL('../../../spec/harness-core.json', import.meta.url)), 'utf8')) as Record<string, unknown>
    for (const k of HARNESS_CORE_ALLOWLIST) expect(k in core).toBe(true)
    expect(isHarnessCoreKeyAllowed('execution_ratio_min_attempts')).toBe(true)
    for (const k of Object.keys(core).filter((k) => !HARNESS_CORE_ALLOWLIST.includes(k))) expect(isHarnessCoreKeyAllowed(k)).toBe(false)
  })
})
