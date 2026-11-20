/**
 * Further advisor surfaces (plan section 4a, rows A-core, D, F, G, H). They are registered here, not in
 * `harness-surfaces.ts`, because that file is on the kernel list. `ADVISOR_SURFACE_REGISTRY` is the layer-flag registry
 * plus these. Surface E1 (reviewer-lens and semantic-hypothesis prompts) is deliberately absent until the control tests
 * pass on a real model (decision D17); the permission logic of tools, the memory write gate and the floor layers stay
 * kernel and have no entry.
 */
import { SURFACE_REGISTRY, isKernelPath, type SurfaceSpec } from './harness-surfaces.js'

/** Keys of `spec/harness-core.json` surface A may touch. Every other key is frozen. */
export const HARNESS_CORE_ALLOWLIST: readonly string[] = ['execution_ratio_min_attempts']

export function isHarnessCoreKeyAllowed(key: string): boolean {
  return HARNESS_CORE_ALLOWLIST.includes(key)
}

/** Preset names among which surface G may choose; no runtime mounting of unknown code. */
export const VETTED_FEATURE_PRESETS = ['cli', 'desktop', 'web'] as const
export const VETTED_BACKENDS = ['proxy', 'claude-cli'] as const

const base = { class: 'I', safetyRelevant: false, feedsCorrectionSignal: false } as const

export const DATA_SURFACES: readonly SurfaceSpec[] = [
  { ...base, id: 'core:execution_ratio_min_attempts', path: 'spec/harness-core.json', scope: ['harness_core_key'],
    valueSchema: { kind: 'number', min: 1, max: 10 }, beacon: { kind: 'slot_read' }, feedsCorrectionSignal: true },
  { ...base, id: 'plan:decomposition_template', slot: 'planTemplates.decomposition', scope: ['planning_template'],
    valueSchema: { kind: 'string' }, beacon: { kind: 'slot_read' } },
  { ...base, id: 'plan:step_structure', slot: 'planTemplates.step_structure', scope: ['planning_template'],
    valueSchema: { kind: 'enum', values: ['single', 'stepwise'] }, beacon: { kind: 'slot_read' } },
  { ...base, id: 'tool:description', slot: 'toolDescriptions', scope: ['tool_description'],
    valueSchema: { kind: 'string' }, beacon: { kind: 'slot_read' } },
  { ...base, id: 'tool:exposure', slot: 'toolExposure', scope: ['tool_exposure'],
    valueSchema: { kind: 'string' }, beacon: { kind: 'slot_read' } },
  { ...base, id: 'preset:features', slot: 'features', scope: ['feature_preset'],
    valueSchema: { kind: 'enum', values: VETTED_FEATURE_PRESETS }, beacon: { kind: 'slot_read' } },
  { ...base, id: 'preset:backend', slot: 'llmBackend', scope: ['backend_binding'],
    valueSchema: { kind: 'enum', values: VETTED_BACKENDS }, beacon: { kind: 'slot_read' } },
  { ...base, id: 'memory:budget_chars', slot: 'memoryBudgetChars', scope: ['memory_parameter'],
    valueSchema: { kind: 'number', min: 500, max: 12000 }, beacon: { kind: 'slot_read' } },
  { ...base, id: 'memory:retention_days', slot: 'AUDIT_MEMORY_RETENTION_DAYS', scope: ['memory_parameter'],
    valueSchema: { kind: 'number', min: 7, max: 365 }, beacon: { kind: 'slot_read' } },
  { ...base, id: 'memory:episodic_retention_days', slot: 'AUDIT_EPISODIC_RETENTION_DAYS', scope: ['memory_parameter'],
    valueSchema: { kind: 'number', min: 7, max: 365 }, beacon: { kind: 'slot_read' } },
]

export const ADVISOR_SURFACE_REGISTRY: readonly SurfaceSpec[] = [...SURFACE_REGISTRY, ...DATA_SURFACES]

/** Surface ids that must never be registered (E1 until D17, and kernel-owned logic). */
export const UNREGISTERED_SURFACE_IDS: readonly string[] = ['reviewer_lens_prompt', 'semantic_hypothesis_prompt', 'tool_permission', 'memory_write_gate']

export type GrantCheck = { ok: true } | { ok: false; reason: string }

/** A change may only use the scopes its surface declares; a need beyond that is rejected. */
export function checkCapabilityGrant(surface: SurfaceSpec, needed: readonly string[]): GrantCheck {
  const extra = needed.filter((n) => !surface.scope.includes(n))
  return extra.length === 0 ? { ok: true } : { ok: false, reason: `capability beyond grant for ${surface.id}: ${extra.join(', ')}` }
}

/** Validate a value against a surface's value schema. */
export function checkSurfaceValue(surface: SurfaceSpec, value: unknown): GrantCheck {
  const s = surface.valueSchema
  if (s.kind === 'boolean') return typeof value === 'boolean' ? { ok: true } : { ok: false, reason: 'expected boolean' }
  if (s.kind === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, reason: 'expected finite number' }
    if (s.min !== undefined && value < s.min) return { ok: false, reason: `below minimum ${s.min}` }
    if (s.max !== undefined && value > s.max) return { ok: false, reason: `above maximum ${s.max}` }
    return { ok: true }
  }
  if (s.kind === 'enum') return typeof value === 'string' && (s.values ?? []).includes(value) ? { ok: true } : { ok: false, reason: 'not an allowed value' }
  return typeof value === 'string' ? { ok: true } : { ok: false, reason: 'expected string' }
}

/** Registered data surfaces whose path is a kernel path (the test expects none). */
export function dataSurfaceKernelOverlaps(extra: readonly string[] = []): SurfaceSpec[] {
  return DATA_SURFACES.filter((s) => s.path !== undefined && isKernelPath(s.path, extra))
}
