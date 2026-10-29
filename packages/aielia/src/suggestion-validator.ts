/**
 * Cheap pre-validation of a `HarnessSuggestion` (plan section 5), run before any model-spending check. Every reason
 * that applies is reported, not just the first. No pattern matching over natural language: task-specific identifiers
 * are checked against an injected list of forbidden exact ids. Class-E steps (compile, typecheck, invariants in an
 * isolated worktree) and the leakage audit belong to later phases.
 */
import type { HarnessSuggestion } from './harness-suggestion.js'
import { findSurface, isKernelPath, protectedLayers, SURFACE_REGISTRY, type SurfaceSpec } from './harness-surfaces.js'
import { findLayer, effectiveState, unmetRequirements, LAYER_SETTINGS, type LayerChoices } from './layer-settings.js'

export type RejectionReason =
  | 'unknown_surface'
  | 'kernel_surface'
  | 'bad_value_shape'
  | 'noop'
  | 'already_in_force'
  | 'operator_pinned'
  | 'unmet_requires'
  | 'dismissed_fingerprint'
  | 'protected_layer_reduction'
  | 'capability_beyond_grant'
  | 'edit_too_large'
  | 'unresolved_evidence'
  | 'model_limited_cluster'
  | 'unknown_reference'
  | 'task_specific_identifier'

export interface ValidationContext {
  registry?: readonly SurfaceSpec[]
  /** Extra kernel patterns (the private list), passed in by the private tree. */
  kernelExtra?: readonly string[]
  choices?: LayerChoices
  /** Layer ids whose flag an operator has pinned in the environment. */
  pinned?: ReadonlySet<string>
  env?: Record<string, string | undefined>
  dismissedFingerprints?: ReadonlySet<string>
  protectedLayers?: ReadonlySet<string>
  /** Capabilities the user has granted. */
  grant?: ReadonlySet<string>
  /** Largest allowed size of the serialised change, in characters. */
  editSizeCap?: number
  /** True when the ref names a real failing train run. Absent resolver means no ref resolves. */
  resolveEvidenceRef?: (ref: string) => boolean
  /** Cluster signatures marked model-limited (the unaided model fails, no harness change would help). */
  modelLimitedClusters?: ReadonlySet<string>
  /** Exact task ids and case identifiers that must not appear in authored text. */
  forbiddenIds?: readonly string[]
}

export interface ValidationResult {
  ok: boolean
  reasons: RejectionReason[]
}

export const DEFAULT_EDIT_SIZE_CAP = 2000

function shapeOk(surface: SurfaceSpec, value: unknown): boolean {
  const s = surface.valueSchema
  switch (s.kind) {
    case 'boolean':
      return typeof value === 'boolean'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) && (s.min === undefined || value >= s.min) && (s.max === undefined || value <= s.max)
    case 'string':
      return typeof value === 'string'
    case 'enum':
      return typeof value === 'string' && (s.values ?? []).includes(value)
  }
}

function referenceExists(ref: string): boolean {
  return LAYER_SETTINGS.some((l) => l.id === ref || l.flag === ref)
}

export function validateSuggestion(s: HarnessSuggestion, ctx: ValidationContext = {}): ValidationResult {
  const reasons: RejectionReason[] = []
  const add = (r: RejectionReason): void => {
    if (!reasons.includes(r)) reasons.push(r)
  }
  const surface = findSurface(s.surfaceId, ctx.registry ?? SURFACE_REGISTRY)

  if (!surface) add('unknown_surface')
  else if (surface.path !== undefined && isKernelPath(surface.path, ctx.kernelExtra)) add('kernel_surface')

  if (s.change.kind === 'noop') add('noop')
  const value = s.change.kind === 'set' ? s.change.value : undefined

  if (surface && s.change.kind === 'set' && !shapeOk(surface, value)) add('bad_value_shape')

  const layer = surface?.layerId ? findLayer(surface.layerId) : undefined
  if (layer && s.change.kind === 'set' && typeof value === 'boolean') {
    const env = ctx.env ?? {}
    const pinned = ctx.pinned ?? new Set<string>()
    const current = effectiveState(layer, ctx.choices, pinned, env)
    if (pinned.has(layer.id)) add('operator_pinned')
    else if (current === value) add('already_in_force')
    if (value && unmetRequirements(layer, { ...ctx.choices, [layer.id]: true }, pinned, env).length > 0) add('unmet_requires')
    if (!value && current && (ctx.protectedLayers ?? protectedLayers).has(layer.id)) add('protected_layer_reduction')
  }

  if (ctx.dismissedFingerprints?.has(s.fingerprint)) add('dismissed_fingerprint')

  const grant = ctx.grant ?? new Set<string>()
  if (s.capabilityNeeds.some((c) => !grant.has(c))) add('capability_beyond_grant')

  if (JSON.stringify(s.change).length > (ctx.editSizeCap ?? DEFAULT_EDIT_SIZE_CAP)) add('edit_too_large')

  const resolve = ctx.resolveEvidenceRef
  if (s.evidenceRefs.length === 0 || s.evidenceRefs.some((r) => !resolve || !resolve(r))) add('unresolved_evidence')

  if (ctx.modelLimitedClusters?.has(s.clusterSignature)) add('model_limited_cluster')

  if (s.change.kind === 'set' && (s.change.references ?? []).some((r) => !referenceExists(r))) add('unknown_reference')

  const forbidden = (ctx.forbiddenIds ?? []).filter((f) => f !== '')
  if (forbidden.length > 0) {
    const authored = [s.whyNotNoop, s.regressionGuard, s.expectedEffect, typeof value === 'string' ? value : '']
    if (forbidden.some((f) => authored.some((t) => t.includes(f)))) add('task_specific_identifier')
  }

  return { ok: reasons.length === 0, reasons }
}
